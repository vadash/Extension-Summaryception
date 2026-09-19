import { afterEach, describe, expect, it, vi } from 'vitest';

const attemptMocks = vi.hoisted(() => ({
    runSingleAttempt: vi.fn(),
    classifyAttemptError: vi.fn(),
    appendRepairFeedback: vi.fn((prompt) => prompt),
    notifyRetryAndWait: vi.fn(async () => {}),
    notifyRouteCycleFailedAndWait: vi.fn(async () => {}),
}));
vi.mock('../src/core/request-attempt.js', () => attemptMocks);

import { RequestRunner } from '../src/core/request-runner.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { makeNotifyRecorder, makeSummarySettings } from './test-helpers.js';

describe('RequestRunner.run outcomes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const mock of Object.values(attemptMocks)) {
            mock.mockReset();
        }
    });

    function makeRequest({ signal, notify, settings, profile } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            settings: resolvedSettings,
            systemPrompt: 'system',
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: signal ?? new AbortController().signal,
            profile: profile ?? resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            notify,
        };
    }

    it('returns completed with the summary text and the resolved profile on a first-attempt success', async () => {
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: true,
            result: 'THE SUMMARY',
            error: undefined,
            cleanedResult: 'THE SUMMARY',
        });

        const request = makeRequest();
        const outcome = await new RequestRunner().run(request);

        expect(outcome.status).toBe('completed');
        expect(outcome.text).toBe('THE SUMMARY');
        expect(outcome.profile).toBe(request.profile);
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
    });

    it('returns aborted for an already-aborted signal without attempting', async () => {
        const recorder = makeNotifyRecorder();
        const controller = new AbortController();
        controller.abort();

        const outcome = await new RequestRunner().run(
            makeRequest({ signal: controller.signal, notify: recorder }),
        );

        expect(outcome).toEqual({ status: 'aborted' });
        expect(attemptMocks.runSingleAttempt).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([{ type: 'transient', kind: 'run-aborted' }]);
    });

    it('returns blocked when the Easy context guard rejects the request', async () => {
        const recorder = makeNotifyRecorder();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: Object.assign(new Error('blocked'), { easyContextGuard: true }),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'blocked' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
        expect(recorder.events).toEqual([]);
    });

    it('returns failed on a non-retryable error without the guard', async () => {
        const recorder = makeNotifyRecorder();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('bad request'),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'failed', attempts: 1 });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
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
        const recorder = makeNotifyRecorder();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('timeout'),
            aborted: false,
            shouldRetry: true,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1);
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: true,
                attempts: RETRY_CONFIG.maxRetries + 1,
                status: null,
            },
        ]);
    });

    it('gives up with failed after one full primary+fallback cycle instead of looping forever', async () => {
        const recorder = makeNotifyRecorder();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('timeout'),
            aborted: false,
            shouldRetry: true,
            hardFailover: false,
        });
        const settings = makeSummarySettings({ fallbackConnectionSource: 'profile' });

        const outcome = await new RequestRunner().run(makeRequest({ settings, notify: recorder }));

        expect(outcome.status).toBe('failed');
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(
            2 * (RETRY_CONFIG.maxRetries + 1),
        );
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: true,
                attempts: 2 * (RETRY_CONFIG.maxRetries + 1),
                status: null,
            },
        ]);
    });

    it('stops at the failing hop when the error is neither retryable nor a hard failover', async () => {
        const recorder = makeNotifyRecorder();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('bad request'),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });
        const settings = makeSummarySettings({ fallbackConnectionSource: 'profile' });

        const outcome = await new RequestRunner().run(makeRequest({ settings, notify: recorder }));

        expect(outcome.status).toBe('failed');
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(1);
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
        const hardFailure = () => ({
            success: false,
            error: new Error('network down'),
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
        });
        attemptMocks.runSingleAttempt
            .mockResolvedValueOnce(hardFailure())
            .mockResolvedValueOnce(hardFailure())
            .mockResolvedValueOnce(hardFailure())
            .mockResolvedValueOnce({
                success: true,
                result: 'OK',
                error: undefined,
                cleanedResult: 'OK',
            });

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
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(4);
        const calls = attemptMocks.runSingleAttempt.mock.calls;
        expect(calls[0][0].connection.connectionProfileId).toBe('aud-1');
        expect(calls[1][0].connection.connectionProfileId).toBe('aud-2');
        expect(calls[2][0].connection).toBe(settings);
        expect(calls[3][0].connection.connectionProfileId).toBe('backup');
        expect(calls.map((call) => call[0].timeoutMs)).toEqual([31000, 32000, 33000, 34000]);
    });
});
