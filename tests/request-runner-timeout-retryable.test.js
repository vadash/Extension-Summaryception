import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { isCancellableConnection } from '../src/core/connectionutil.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { RequestRunner } from '../src/core/request-runner.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { makeNotifyRecorder, makeSummarySettings, makeUsageLedger } from './test-helpers.js';

const usageLedger = await makeUsageLedger();

describe('call walk timeout retryability vs cancellation capability', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeRequest({ settings, notify } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            prompt: 'prompt',
            repairPrompt: '',
            recall: 'recall',
            repairRecall: 'repair recall',
            signal: new AbortController().signal,
            profile: resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            notify: notify ?? makeNotifyRecorder(),
            usage: usageLedger,
        };
    }

    it('exposes the cancellation capability per registered provider', () => {
        expect(
            isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'default' }),
        ).toBe(false);
        expect(
            isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'profile' }),
        ).toBe(true);
    });

    /**
     * The request mock never resolves, so every attempt hangs until its
     * timeout fires; the walk classifies each timeout the same way.
     */
    async function runHungWalk({ settings, notify }) {
        connectionMocks.sendSummarizerRequest.mockReturnValue(new Promise(() => {}));
        const pending = new RequestRunner().run(makeRequest({ settings, notify }));
        await vi.runAllTimersAsync();
        return await pending;
    }

    it('marks the timeout non-retryable on the uncancellable default route', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        const outcome = await runHungWalk({
            settings: makeSummarySettings({
                connectionSource: 'default',
                requestTimeoutSeconds: 0.01,
            }),
            notify: recorder,
        });

        expect(outcome).toEqual({ status: 'failed', attempts: 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        expect(recorder.events[recorder.events.length - 1]).toEqual({
            type: 'transient',
            kind: 'run-failed',
            retriesExhausted: false,
            attempts: 1,
            status: null,
        });
    });

    it('keeps the timeout retryable on the cancellable profile route', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        const outcome = await runHungWalk({
            settings: makeSummarySettings({
                connectionSource: 'profile',
                requestTimeoutSeconds: 0.01,
            }),
            notify: recorder,
        });

        expect(outcome).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
        expect(recorder.events[recorder.events.length - 1]).toMatchObject({
            kind: 'run-failed',
            retriesExhausted: true,
            attempts: RETRY_CONFIG.maxRetries + 1,
        });
    });
});
