import { describe, expect, it, vi } from 'vitest';
import { SummarizerQueue } from '../src/core/summarizer-queue.js';

function deferred() {
    /** @type {(value: unknown) => void} */
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function makeQueue(overrides = {}) {
    const deps = {
        drainOneCycle: vi.fn(async () => 'idle'),
        abort: vi.fn(),
        refreshUi: vi.fn(),
        withUsageRun: vi.fn(async (_label, callback) => await callback()),
        yieldCycle: vi.fn(async () => {}),
        ...overrides,
    };
    const queue = new SummarizerQueue(deps);
    return { queue, deps };
}

describe('SummarizerQueue', () => {
    it('starts a drain on the first request', async () => {
        const { queue, deps } = makeQueue();

        await queue.request();

        expect(deps.withUsageRun).toHaveBeenCalledWith('auto worker drain', expect.any(Function));
        expect(deps.drainOneCycle).toHaveBeenCalledTimes(1);
        expect(queue.getIsSummarizing()).toBe(false);
        expect(queue.getPhase()).toBe('idle');
    });

    it('returns the active promise for concurrent requests', async () => {
        const cycle = deferred();
        const { queue, deps } = makeQueue({
            drainOneCycle: vi.fn(async () => await cycle.promise),
        });

        const firstRun = queue.request();
        await vi.waitFor(() => expect(deps.drainOneCycle).toHaveBeenCalledTimes(1));

        const secondRun = queue.request();

        expect(secondRun).toBe(firstRun);
        cycle.resolve('idle');
        await firstRun;
    });

    it('runs another cycle when work becomes dirty during a drain', async () => {
        /** @type {SummarizerQueue} */
        let queue;
        const drainOneCycle = vi.fn(async () => {
            if (drainOneCycle.mock.calls.length === 1) {
                queue.request();
            }
            return 'idle';
        });
        ({ queue } = makeQueue({ drainOneCycle }));

        await queue.request();

        expect(drainOneCycle).toHaveBeenCalledTimes(2);
    });

    it('stops a failed cycle without looping on dirty work', async () => {
        /** @type {SummarizerQueue} */
        let queue;
        const drainOneCycle = vi.fn(async () => {
            if (drainOneCycle.mock.calls.length === 1) {
                queue.request();
                return 'failed';
            }
            return 'idle';
        });
        ({ queue } = makeQueue({ drainOneCycle }));

        await queue.request();

        expect(drainOneCycle).toHaveBeenCalledTimes(1);

        await queue.request();

        expect(drainOneCycle).toHaveBeenCalledTimes(2);
    });

    it('clears pending, dirty, and manual busy state on abort', async () => {
        const cycle = deferred();
        const { queue, deps } = makeQueue({
            drainOneCycle: vi.fn(async () => await cycle.promise),
        });

        queue.setSummarizing(true);
        const run = queue.request();
        await vi.waitFor(() => expect(deps.drainOneCycle).toHaveBeenCalledTimes(1));
        queue.request();

        queue.abort();
        cycle.resolve('idle');
        await run;

        expect(deps.abort).toHaveBeenCalledTimes(1);
        expect(deps.drainOneCycle).toHaveBeenCalledTimes(1);
        expect(queue.getIsSummarizing()).toBe(false);
    });

    it('includes manual busy state in getIsSummarizing', () => {
        const { queue } = makeQueue();

        expect(queue.getIsSummarizing()).toBe(false);
        queue.setSummarizing(true);
        expect(queue.getIsSummarizing()).toBe(true);
        queue.setSummarizing(false);
        expect(queue.getIsSummarizing()).toBe(false);
    });

    it('tracks layer0, promoting, yielding, and idle phases', async () => {
        /** @type {SummarizerQueue} */
        let queue;
        const phases = [];
        const drainOneCycle = vi.fn(async (ctx) => {
            if (drainOneCycle.mock.calls.length === 1) {
                ctx.setPhase('layer0');
                return 'processed';
            }
            if (drainOneCycle.mock.calls.length === 2) {
                ctx.setPhase('promoting');
                return 'processed';
            }
            return 'idle';
        });
        ({ queue } = makeQueue({
            drainOneCycle,
            refreshUi: () => {
                phases.push(queue.getPhase());
            },
        }));

        await queue.request();

        expect(phases).toContain('layer0');
        expect(phases).toContain('promoting');
        expect(phases).toContain('yielding');
        expect(phases.at(-1)).toBe('idle');
    });

    it('runs the afterDrain callback when the worker finishes', async () => {
        const afterDrain = vi.fn(async () => {});
        const { queue } = makeQueue({ afterDrain });

        await queue.request();

        expect(afterDrain).toHaveBeenCalledTimes(1);
    });
});
