import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { RequestRunner } from '../src/core/request-runner.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { NOTIFY_EVENTS, UI_MODES } from '../src/foundation/constants.js';
import { makeNotifyRecorder, makeSummarySettings } from './test-helpers.js';

/** Minimal valid summary passage accepted by the real Output Hygiene chain. */
const VALID_SUMMARY = '[NARRATIVE]\nA concise summary.\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * Run outcomes through the real Route Series; only the provider call is
 * mocked. The outcomes, notify events, and call counts below are the
 * runner's contract (ADR-0019); retries consume the profile frozen at
 * dispatch (ADR-0023).
 */
describe('RequestRunner.run outcomes', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeRequest({ signal, notify, settings, profile } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: signal ?? new AbortController().signal,
            profile: profile ?? resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            notify,
        };
    }

    it('returns completed with the summary text and the resolved profile on a first-attempt success', async () => {
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);

        const request = makeRequest();
        const outcome = await new RequestRunner().run(request);

        expect(outcome.status).toBe('completed');
        expect(outcome.text).toBe(VALID_SUMMARY);
        expect(outcome.profile).toBe(request.profile);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
    });

    it('retries consume the profile frozen at dispatch, not live settings', async () => {
        vi.useFakeTimers();
        const settings = makeSummarySettings({ layer0SummaryTokenTarget: 300 });
        const request = makeRequest({ settings });
        connectionMocks.sendSummarizerRequest.mockImplementationOnce(() => {
            // A mid-run settings edit must not reach an in-flight call's retries (ADR-0023).
            settings.uiMode = UI_MODES.EASY;
            settings.advancedModelContext = 10;
            settings.layer0SummaryTokenTarget = 999;
            return Promise.reject(new Error('timeout'));
        });
        connectionMocks.sendSummarizerRequest.mockResolvedValueOnce(VALID_SUMMARY);

        const pending = new RequestRunner().run(request);
        await vi.runAllTimersAsync();
        const outcome = await pending;

        expect(outcome.status).toBe('completed');
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        expect(outcome.profile).toBe(request.profile);
        expect(outcome.profile.policy.easyContextLimit).toBeNull();
        expect(outcome.profile.policy.sizeGuard.target).toBe(300);
    });

    it('returns aborted for an already-aborted signal without attempting', async () => {
        const recorder = makeNotifyRecorder();
        const controller = new AbortController();
        controller.abort();

        const outcome = await new RequestRunner().run(
            makeRequest({ signal: controller.signal, notify: recorder }),
        );

        expect(outcome).toEqual({ status: 'aborted' });
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([{ type: 'transient', kind: 'run-aborted' }]);
    });

    it('returns blocked when the Easy context guard rejects the request', async () => {
        const recorder = makeNotifyRecorder();
        const settings = makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 });

        const outcome = await new RequestRunner().run(
            makeRequest({ settings, notify: recorder, prompt: 'x'.repeat(4000) }),
        );

        expect(outcome).toEqual({ status: 'blocked' });
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        // The attempt layer emits the structured guard event (ADR-0019); the
        // guard-block branch adds no run-failed event on top.
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0].kind).toBe(NOTIFY_EVENTS.EASY_GUARD_BLOCKED);
    });

    it('returns failed on a non-retryable error without the guard', async () => {
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'failed', attempts: 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: false,
                attempts: 1,
                status: null,
            },
        ]);
    });

    it('returns failed after exhausting retries for retryable errors', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));

        const pending = new RequestRunner().run(makeRequest({ notify: recorder }));
        await vi.runAllTimersAsync();
        const outcome = await pending;

        expect(outcome).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
        // Mid-run retries surface as structured retry-wait events (ADR-0019).
        const retryWaits = recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT);
        expect(retryWaits.map((e) => e.attempt)).toEqual([0, 1, 2]);
        expect(recorder.events[recorder.events.length - 1]).toEqual({
            type: 'transient',
            kind: 'run-failed',
            retriesExhausted: true,
            attempts: RETRY_CONFIG.maxRetries + 1,
            status: null,
        });
    });

    it('gives up with failed after one full primary+fallback cycle instead of looping forever', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));
        const settings = makeSummarySettings({ fallbackConnectionSource: 'profile' });

        const pending = new RequestRunner().run(makeRequest({ settings, notify: recorder }));
        await vi.runAllTimersAsync();
        const outcome = await pending;

        expect(outcome.status).toBe('failed');
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            2 * (RETRY_CONFIG.maxRetries + 1),
        );
        // Three retry waits per route, one route-cycle wait between the
        // routes, then the run-failed event (ADR-0019).
        const retryWaits = recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT);
        expect(retryWaits.map((e) => e.attempt)).toEqual([0, 1, 2, 0, 1, 2]);
        const routeCycleWaits = recorder.events.filter(
            (e) => e.kind === NOTIFY_EVENTS.ROUTE_CYCLE_WAIT,
        );
        expect(routeCycleWaits).toHaveLength(1);
        expect(recorder.events[recorder.events.length - 1]).toEqual({
            type: 'transient',
            kind: 'run-failed',
            retriesExhausted: true,
            attempts: 2 * (RETRY_CONFIG.maxRetries + 1),
            status: null,
        });
    });

    it('stops at the failing hop when the error is neither retryable nor a hard failover', async () => {
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));
        const settings = makeSummarySettings({ fallbackConnectionSource: 'profile' });

        const outcome = await new RequestRunner().run(makeRequest({ settings, notify: recorder }));

        expect(outcome.status).toBe('failed');
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(1);
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: false,
                attempts: 1,
                status: null,
            },
        ]);
    });

    it('walks the resolved route series in order on hard failover', async () => {
        connectionMocks.sendSummarizerRequest
            .mockRejectedValueOnce(new Error('Failed to fetch'))
            .mockRejectedValueOnce(new Error('Failed to fetch'))
            .mockRejectedValueOnce(new Error('Failed to fetch'))
            .mockResolvedValueOnce(VALID_SUMMARY);

        const settings = makeSummarySettings({
            auditorConnectionSource: 'profile',
            auditorConnectionProfileId: 'aud-1',
            auditorRequestTimeoutSeconds: 31,
            auditorFallbackConnectionSource: 'profile',
            auditorFallbackConnectionProfileId: 'aud-2',
            auditorFallbackRequestTimeoutSeconds: 32,
            auditorNarrativeFallback: true,
            requestTimeoutSeconds: 33,
            fallbackConnectionSource: 'profile',
            fallbackConnectionProfileId: 'backup',
            fallbackRequestTimeoutSeconds: 34,
        });
        const profile = resolveCallProfile(settings, { kind: 'auditor' });

        const outcome = await new RequestRunner().run(
            makeRequest({ settings, profile, notify: makeNotifyRecorder() }),
        );

        expect(outcome.status).toBe('completed');
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(4);
        const calls = connectionMocks.sendSummarizerRequest.mock.calls;
        expect(calls[0][0].settings.connectionProfileId).toBe('aud-1');
        expect(calls[1][0].settings.connectionProfileId).toBe('aud-2');
        expect(calls[2][0].settings).toBe(settings);
        expect(calls[3][0].settings.connectionProfileId).toBe('backup');
        // Route timeouts are resolved by the Call Profile, not read live.
        expect(profile.policy.routes.map((route) => route.timeoutMs)).toEqual([
            31000, 32000, 33000, 34000,
        ]);
    });
});
