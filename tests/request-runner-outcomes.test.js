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
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { installBrowserRuntimeStub, makeSummarySettings } from './test-helpers.js';

describe('RequestRunner.run outcomes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const mock of Object.values(attemptMocks)) {
            mock.mockReset();
        }
        delete globalThis.toastr;
        delete globalThis.$;
    });

    function makeRequest({ signal } = {}) {
        return {
            settings: makeSummarySettings(),
            systemPrompt: 'system',
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: signal ?? new AbortController().signal,
            metadata: { kind: 'layer0' },
        };
    }

    it('returns completed with the summary text on a first-attempt success', async () => {
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: true,
            result: 'THE SUMMARY',
            error: undefined,
            cleanedResult: 'THE SUMMARY',
        });

        const outcome = await new RequestRunner().run(makeRequest());

        expect(outcome).toEqual({ status: 'completed', text: 'THE SUMMARY' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
    });

    it('returns aborted for an already-aborted signal without attempting', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const controller = new AbortController();
        controller.abort();

        const outcome = await new RequestRunner().run(makeRequest({ signal: controller.signal }));

        expect(outcome).toEqual({ status: 'aborted' });
        expect(attemptMocks.runSingleAttempt).not.toHaveBeenCalled();
        expect(toastr.warning).toHaveBeenCalled();
    });

    it('returns blocked when the Easy context guard rejects the request', async () => {
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: Object.assign(new Error('blocked'), { easyContextGuard: true }),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest());

        expect(outcome).toEqual({ status: 'blocked' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
    });

    it('returns failed on a non-retryable error without the guard', async () => {
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('bad request'),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest());

        expect(outcome).toEqual({ status: 'failed' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
    });

    it('returns failed after exhausting retries for retryable errors', async () => {
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('timeout'),
            aborted: false,
            shouldRetry: true,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest());

        expect(outcome).toEqual({ status: 'failed' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1);
    });
});
