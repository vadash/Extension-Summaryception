import { afterEach, describe, expect, it, vi } from 'vitest';

const runnerMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../src/core/request-runner.js', () => ({
    RequestRunner: class {
        constructor() {
            return { run: runnerMocks.run };
        }
    },
}));
vi.mock('../src/foundation/settings.js', () => ({
    getEffectiveSettings: vi.fn(() => ({})),
}));
vi.mock('../src/core/summarizer-pipeline.js', async () => {
    const { resolveCallProfile } = await import('../src/core/call-profile.js');
    return {
        buildSummarizerPipelineInput: vi.fn(async (input) => ({
            ...input,
            profile: resolveCallProfile(input.settings ?? {}, input.metadata ?? {}),
        })),
        traceSummarizerInputTokens: vi.fn(async () => {}),
    };
});

import { abortAllRequests, callSummarizer, isRequestLive } from '../src/core/summarizer-request.js';
import { SummarizerQueue } from '../src/core/summarizer-queue.js';

/** Build a queue with injected fake dependencies. The queue needs no host context. */
function makeGateQueue(drainOneCycle, { isRequestLive = () => false } = {}) {
    return new SummarizerQueue({
        drainOneCycle,
        abortAllRequests: vi.fn(),
        isRequestLive: vi.fn(isRequestLive),
        refreshUi: vi.fn(),
        withUsageRun: vi.fn(async (_label, work) => await work()),
        yieldCycle: vi.fn(async () => {}),
    });
}

/** Run a request that settles only when its signal aborts. @returns {Promise<{status: string}>} */
function abortableRun(request) {
    return new Promise((resolve) => {
        request.signal.addEventListener('abort', () => resolve({ status: 'aborted' }));
    });
}

describe('summarizer request registry', () => {
    afterEach(() => {
        runnerMocks.run.mockReset();
    });

    it('gives two concurrent requests their own abort signals', async () => {
        let releaseFirst;
        runnerMocks.run
            .mockImplementationOnce(
                (request) =>
                    new Promise((resolve) => {
                        request.signal.addEventListener('abort', () =>
                            resolve({ status: 'aborted' }),
                        );
                        releaseFirst = () => resolve({ status: 'completed', text: 'a' });
                    }),
            )
            .mockImplementationOnce(abortableRun);

        const first = callSummarizer({ storyTxt: 'story', contextStr: 'context' });
        const second = callSummarizer({ storyTxt: 'story', contextStr: 'context' });
        await vi.waitFor(() => expect(runnerMocks.run).toHaveBeenCalledTimes(2));

        const [firstSignal, secondSignal] = runnerMocks.run.mock.calls.map(([req]) => req.signal);
        expect(firstSignal).not.toBe(secondSignal);
        expect(isRequestLive()).toBe(true);

        releaseFirst();
        await expect(first).resolves.toEqual({ status: 'completed', text: 'a' });

        // The settled request must neither clobber the registry nor touch the live one.
        expect(isRequestLive()).toBe(true);
        expect(secondSignal.aborted).toBe(false);

        abortAllRequests();
        expect(secondSignal.aborted).toBe(true);
        await expect(second).resolves.toEqual({ status: 'aborted' });
        expect(isRequestLive()).toBe(false);
    });

    it('aborts every live request signal at once', async () => {
        runnerMocks.run.mockImplementation(abortableRun);

        const first = callSummarizer({ storyTxt: 'story', contextStr: 'context' });
        const second = callSummarizer({ storyTxt: 'story', contextStr: 'context' });
        await vi.waitFor(() => expect(runnerMocks.run).toHaveBeenCalledTimes(2));

        const signals = runnerMocks.run.mock.calls.map(([req]) => req.signal);
        expect(signals[0].aborted).toBe(false);
        expect(signals[1].aborted).toBe(false);

        abortAllRequests();

        await expect(first).resolves.toEqual({ status: 'aborted' });
        await expect(second).resolves.toEqual({ status: 'aborted' });
        expect(isRequestLive()).toBe(false);
    });

    it('reports no live request once both requests settle', async () => {
        runnerMocks.run.mockResolvedValue({ status: 'completed', text: 'done' });

        await Promise.all([
            callSummarizer({ storyTxt: 'story', contextStr: 'context' }),
            callSummarizer({ storyTxt: 'story', contextStr: 'context' }),
        ]);

        expect(isRequestLive()).toBe(false);
    });
});

describe('work gate leases', () => {
    it('reports busy while a lease is open and free after it ends', () => {
        const queue = makeGateQueue(async () => ({ status: 'idle' }));
        expect(queue.isBusy()).toBe(false);

        const run = queue.beginRun('manual-run');
        expect(queue.isBusy()).toBe(true);

        run.end();
        expect(queue.isBusy()).toBe(false);
    });

    it('counts the running worker as busy', async () => {
        let inCycle;
        const seen = new Promise((resolve) => {
            inCycle = resolve;
        });
        let calls = 0;
        const queue = makeGateQueue(async () => {
            calls++;
            inCycle();
            return { status: 'idle' };
        });

        const draining = queue.request();
        await seen;
        expect(queue.isBusy()).toBe(true);

        await draining;
        expect(calls).toBe(1);
        expect(queue.isBusy()).toBe(false);
    });

    it('counts a live request as busy', () => {
        const queue = makeGateQueue(async () => ({ status: 'idle' }), {
            isRequestLive: () => true,
        });

        expect(queue.isBusy()).toBe(true);
    });

    it('stop aborts requests, sets the stop intent on live leases, and drops queued work', () => {
        const queue = makeGateQueue(async () => ({ status: 'idle' }));
        const run = queue.beginRun('regeneration');
        queue.pending = true;
        queue.dirty = true;
        expect(run.isStopped()).toBe(false);

        queue.stop();

        expect(queue.abortAllRequests).toHaveBeenCalledTimes(1);
        expect(run.isStopped()).toBe(true);
        expect(queue.pending).toBe(false);
        expect(queue.dirty).toBe(false);
        expect(queue.isBusy()).toBe(true); // stop never releases the lease itself
        run.end();
        expect(queue.isBusy()).toBe(false);
    });

    it('does not stop a lease opened after stop', () => {
        const queue = makeGateQueue(async () => ({ status: 'idle' }));

        queue.stop();
        const run = queue.beginRun('manual-run');

        expect(run.isStopped()).toBe(false);
    });

    it('defers the automatic worker while a foreground lease is live', async () => {
        let calls = 0;
        const queue = makeGateQueue(async () => {
            calls++;
            return { status: 'idle' };
        });
        const run = queue.beginRun('manual-run');

        await queue.request();

        expect(calls).toBe(0);
        expect(queue.pending).toBe(true);
        expect(queue.dirty).toBe(true);

        run.end();
        expect(queue.isBusy()).toBe(false);

        // The next trigger's rerun picks up the deferred work.
        await queue.request();
        expect(calls).toBe(1);
    });
});
