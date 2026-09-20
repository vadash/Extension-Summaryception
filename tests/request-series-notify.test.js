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
import { notifyRouteCycleFailedAndWait, runRouteSeries } from '../src/core/request-series.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

/**
 * The request series emits structured notify events (ADR-0019) instead of
 * calling the notification library. Retry waits stay in retry policy. The
 * abort signal cuts them short independently of any display duration.
 */
describe('request series notify events', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeSeriesParams(overrides = {}) {
        return {
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: new AbortController().signal,
            profile: resolveCallProfile(makeSummarySettings(), { kind: 'layer0' }),
            route: { connection: makeSummarySettings(), timeoutMs: 30000 },
            routeLabel: 'primary',
            maxRetries: RETRY_CONFIG.maxRetries,
            notify: makeNotifyRecorder(),
            ...overrides,
        };
    }

    it('emits a structured guard event when the Easy context guard blocks', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        const result = await runRouteSeries(
            makeSeriesParams({
                notify: recorder,
                profile: resolveCallProfile(
                    makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 }),
                    { kind: 'layer0' },
                ),
                prompt: 'x'.repeat(4000),
            }),
        );

        expect(result.status).toBe('guard-stopped');
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

        const pending = runRouteSeries(
            makeSeriesParams({ notify: recorder, signal: controller.signal }),
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
        const result = await pending;

        expect(result.status).toBe('aborted');
        expect(recorder.events).toHaveLength(1);
    });

    it('emits the route-cycle event and waits before the fallback route', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        const controller = new AbortController();

        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));
        vi.useFakeTimers();

        const pending = notifyRouteCycleFailedAndWait({
            healthBucket: 'layer0',
            signal: controller.signal,
            notify: recorder,
        });
        await vi.runAllTimersAsync();
        await pending;

        expect(toastr.error).not.toHaveBeenCalled();
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0].kind).toBe(NOTIFY_EVENTS.ROUTE_CYCLE_WAIT);
        // Backoff band for the route-cycle attempt: base * multiplier^3 plus
        // jitter, no Retry-After on the synthetic error.
        const band =
            RETRY_CONFIG.baseDelay * RETRY_CONFIG.backoffMultiplier ** RETRY_CONFIG.maxRetries;
        expect(recorder.events[0].delayMs).toBeGreaterThanOrEqual(band);
        expect(recorder.events[0].delayMs).toBeLessThan(band + RETRY_CONFIG.baseDelay);
    });
});
