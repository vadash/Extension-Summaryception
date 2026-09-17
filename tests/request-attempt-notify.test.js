import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
    resolveSummarizerConnectionSettings: vi.fn((settings) => settings),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { NOTIFY_EVENTS, UI_MODES } from '../src/foundation/constants.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import {
    notifyRetryAndWait,
    notifyRouteCycleFailedAndWait,
    runSingleAttempt,
} from '../src/core/request-attempt.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

/**
 * The attempt layer emits structured notify events (ADR-0004) instead of
 * calling the notification library. Retry waits stay in retry policy. The
 * abort signal cuts them short independently of any display duration.
 */
describe('request attempt notify events', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        for (const mock of Object.values(connectionMocks)) {
            mock.mockReset();
        }
    });

    function makeAttemptParams(overrides = {}) {
        return {
            settings: makeSummarySettings(),
            systemPrompt: 'system',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
            attempt: 0,
            maxRetries: RETRY_CONFIG.maxRetries,
            routeLabel: 'primary',
            timeoutMs: 30000,
            ...overrides,
        };
    }

    it('emits a structured guard event when the Easy context guard blocks', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        const params = makeAttemptParams({
            notify: recorder,
            settings: makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 }),
            prompt: 'x'.repeat(4000),
        });

        const result = await runSingleAttempt(params);

        expect(result.failureStatus).toBe('easy-context-guard');
        expect(result.shouldRetry).toBe(false);
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
        vi.useFakeTimers();
        const controller = new AbortController();
        const error = Object.assign(new Error('rate limited'), { retryAfter: 60, status: 429 });

        const waiting = notifyRetryAndWait({
            lastError: error,
            attempt: 0,
            signal: controller.signal,
            maxRetries: RETRY_CONFIG.maxRetries,
            notify: recorder,
        });

        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.RETRY_WAIT,
                attempt: 0,
                delayMs: 60000,
                maxRetries: RETRY_CONFIG.maxRetries,
            },
        ]);

        controller.abort();
        await waiting;

        expect(recorder.events).toHaveLength(1);
    });

    it('emits the route-cycle event and abort cuts that wait short too', async () => {
        const recorder = makeNotifyRecorder();
        vi.useFakeTimers();
        const controller = new AbortController();

        const waiting = notifyRouteCycleFailedAndWait({
            healthBucket: 'layer0',
            signal: controller.signal,
            notify: recorder,
        });

        const [event] = recorder.events;
        expect(event.type).toBe('transient');
        expect(event.kind).toBe(NOTIFY_EVENTS.ROUTE_CYCLE_WAIT);
        const minDelay = RETRY_CONFIG.baseDelay * RETRY_CONFIG.backoffMultiplier ** 3;
        expect(event.delayMs).toBeGreaterThanOrEqual(minDelay);
        expect(event.delayMs).toBeLessThan(minDelay + RETRY_CONFIG.baseDelay);

        controller.abort();
        await waiting;

        expect(recorder.events).toHaveLength(1);
    });
});
