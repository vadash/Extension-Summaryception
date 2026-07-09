import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    classifyAttemptRetryStatus,
    computeAttemptTimeoutMs,
    computeRetryDelay,
    getPrimaryHealthBucket,
    getRetryStopReason,
    isHardNetworkError,
    shouldSwitchToRepairPrompt,
} from '../src/core/request-retry-policy.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('request retry policy', () => {
    it('uses longer attempt timeouts for Layer 0 than promotions', () => {
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 0)).toBe(120000);
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 1)).toBe(90000);
        expect(computeAttemptTimeoutMs({ kind: 'promotion' }, 0)).toBe(90000);
        expect(computeAttemptTimeoutMs({ kind: 'promotion' }, 1)).toBe(60000);
    });

    it('honors Retry-After but clamps it to the retry max delay', () => {
        expect(computeRetryDelay({ retryAfter: 999 }, 0)).toBe(RETRY_CONFIG.maxDelay);
    });

    it('computes exponential retry delay with bounded jitter', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.25);

        expect(computeRetryDelay(new Error('server error'), 2)).toBe(8500);
    });

    it('detects hard network failures without retrying the same route', () => {
        expect(isHardNetworkError(new TypeError('Failed to fetch'))).toBe(true);
        expect(isHardNetworkError(new Error('ECONNREFUSED: connection refused'))).toBe(true);
        expect(isHardNetworkError(new Error('Server Error: 502'))).toBe(false);
    });

    it('classifies aborts, hard failover, retryable errors, and terminal errors', () => {
        expect(classifyAttemptRetryStatus(new Error('Aborted by user'), false)).toMatchObject({
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'aborted',
        });
        expect(classifyAttemptRetryStatus(new TypeError('Failed to fetch'), false)).toMatchObject({
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
            failureStatus: 'hard-failover',
        });
        expect(classifyAttemptRetryStatus(new Error('temporary timeout'), false)).toMatchObject({
            aborted: false,
            shouldRetry: true,
            hardFailover: false,
            failureStatus: 'failed',
        });
        expect(classifyAttemptRetryStatus(new Error('bad request'), false)).toMatchObject({
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'failed',
        });
    });

    it('switches to repair prompts only for retryable validation failures before exhaustion', () => {
        expect(
            shouldSwitchToRepairPrompt({
                attemptResult: { shouldRetry: true, failureStatus: 'integrity-rejected' },
                attempt: 0,
                maxRetries: 1,
                repairPrompt: 'repair',
            }),
        ).toBe(true);
        expect(
            shouldSwitchToRepairPrompt({
                attemptResult: { shouldRetry: true, failureStatus: 'failed' },
                attempt: 0,
                maxRetries: 1,
                repairPrompt: 'repair',
            }),
        ).toBe(false);
        expect(
            shouldSwitchToRepairPrompt({
                attemptResult: { shouldRetry: true, failureStatus: 'empty' },
                attempt: 1,
                maxRetries: 1,
                repairPrompt: 'repair',
            }),
        ).toBe(false);
    });

    it('returns explicit retry stop reasons for runner logging', () => {
        expect(getRetryStopReason({ hardFailover: true, shouldRetry: false }, 0, 3)).toBe(
            'hard-failover',
        );
        expect(getRetryStopReason({ shouldRetry: false }, 0, 3)).toBe('non-retryable');
        expect(getRetryStopReason({ shouldRetry: true }, 0, 0)).toBe('primary-probe-failed');
        expect(getRetryStopReason({ shouldRetry: true }, 3, 3)).toBe('retries-exhausted');
        expect(getRetryStopReason({ shouldRetry: true }, 1, 3)).toBe('');
    });

    it('tracks primary route health separately for Layer 0 and promotion calls', () => {
        expect(getPrimaryHealthBucket({ kind: 'layer0' })).toBe('layer0');
        expect(getPrimaryHealthBucket({ kind: 'promotion' })).toBe('l1plus');
        expect(getPrimaryHealthBucket({})).toBe('layer0');
    });
});
