import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { NOTIFY_EVENTS, UI_MODES } from '../src/foundation/constants.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { RequestRunner } from '../src/core/request-runner.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
    makeUsageLedger,
} from './test-helpers.js';

const usageLedger = await makeUsageLedger();

/**
 * The call walk emits structured notify events (ADR-0019) instead of calling
 * the notification library. Retry waits stay in retry policy; the walk owns
 * the route-cycle wait. The abort signal cuts either wait short.
 */
describe('RequestRunner.run notify events', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeRequest({ settings, profile, signal, notify, prompt } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            prompt: prompt ?? 'prompt',
            repairPrompt: 'repair',
            recall: 'recall',
            repairRecall: 'repair recall',
            signal: signal ?? new AbortController().signal,
            profile: profile ?? resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            notify: notify ?? makeNotifyRecorder(),
            usage: usageLedger,
        };
    }

    it('emits a structured guard event when the Easy context guard blocks', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();

        const outcome = await new RequestRunner().run(
            makeRequest({
                notify: recorder,
                profile: resolveCallProfile(
                    makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 }),
                    { kind: 'layer0' },
                ),
                prompt: 'x'.repeat(4000),
            }),
        );

        expect(outcome).toEqual({ status: 'blocked' });
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        expect(toastr.error).not.toHaveBeenCalled();
        expect(recorder.events).toHaveLength(1);
        const event = recorder.events[0];
        expect(event.type).toBe('transient');
        expect(event.kind).toBe(NOTIFY_EVENTS.EASY_GUARD_BLOCKED);
        expect(event.tokens).toBeGreaterThan(10);
        expect(event.limit).toBe(10);
        expect(typeof event.estimated).toBe('boolean');
        expect(typeof event.label).toBe('string');
    });

    it('emits the retry event before waiting and abort cuts the wait short', async () => {
        const recorder = makeNotifyRecorder();
        const controller = new AbortController();
        connectionMocks.sendSummarizerRequest.mockRejectedValueOnce(
            Object.assign(new Error('rate limited'), { retryAfter: 60, status: 429 }),
        );

        const pending = new RequestRunner().run(
            makeRequest({ notify: recorder, signal: controller.signal }),
        );
        // Park on the retry wait: the first attempt failed, the wait runs.
        await vi.waitFor(() => expect(recorder.events).toHaveLength(1));
        expect(recorder.events[0]).toEqual({
            type: 'transient',
            kind: NOTIFY_EVENTS.RETRY_WAIT,
            attempt: 0,
            delayMs: 60000,
            maxRetries: RETRY_CONFIG.maxRetries,
        });

        controller.abort();
        const outcome = await pending;

        expect(outcome).toEqual({ status: 'aborted' });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        // The walk re-checks the signal on the next attempt and renders the abort.
        expect(recorder.events.map((event) => event.kind)).toEqual([
            NOTIFY_EVENTS.RETRY_WAIT,
            NOTIFY_EVENTS.RUN_ABORTED,
        ]);
    });

    it('emits the route-cycle event and waits before retrying the primary', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));
        vi.useFakeTimers();

        const outcome = await (async () => {
            const pending = new RequestRunner().run(
                makeRequest({
                    settings: makeSummarySettings({
                        fallbackConnectionSource: 'profile',
                        fallbackConnectionProfileId: 'backup',
                    }),
                    notify: recorder,
                }),
            );
            await vi.runAllTimersAsync();
            return pending;
        })();

        expect(outcome.status).toBe('failed');
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            2 * (RETRY_CONFIG.maxRetries + 1),
        );
        expect(toastr.error).not.toHaveBeenCalled();

        const routeCycleWaits = recorder.events.filter(
            (event) => event.kind === NOTIFY_EVENTS.ROUTE_CYCLE_WAIT,
        );
        expect(routeCycleWaits).toHaveLength(1);
        // Backoff band for the route-cycle attempt: base * multiplier to the
        // power of the retry budget, plus jitter; no Retry-After header on
        // the synthetic error.
        const band =
            RETRY_CONFIG.baseDelay * RETRY_CONFIG.backoffMultiplier ** RETRY_CONFIG.maxRetries;
        expect(routeCycleWaits[0].delayMs).toBeGreaterThanOrEqual(band);
        expect(routeCycleWaits[0].delayMs).toBeLessThan(band + RETRY_CONFIG.baseDelay);

        const kinds = recorder.events.map((event) => event.kind);
        expect(kinds.filter((kind) => kind === NOTIFY_EVENTS.RETRY_WAIT)).toHaveLength(6);
        expect(kinds.indexOf(NOTIFY_EVENTS.ROUTE_CYCLE_WAIT)).toBe(
            kinds.lastIndexOf(NOTIFY_EVENTS.RETRY_WAIT) + 1,
        );
        expect(kinds[kinds.length - 1]).toBe(NOTIFY_EVENTS.RUN_FAILED);
    });
});
