import { describe, expect, it } from 'vitest';

import { RETRY_CONFIG } from '../src/foundation/retry.js';
import {
    classifyAttemptRetryStatus,
    computeAttemptTimeoutMs,
    getPrimaryHealthBucket,
    getRetryStopReason,
    isHardNetworkError,
    shouldSwitchToRepairPrompt,
} from '../src/core/request-retry-policy.js';

describe('computeAttemptTimeoutMs', () => {
    it('returns the full configured timeout on every attempt', () => {
        const settings = { requestTimeoutSeconds: 30 };
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 0, settings)).toBe(30000);
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 1, settings)).toBe(30000);
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 3, settings)).toBe(30000);
    });

    it('reads each route from its own settings field', () => {
        const settings = {
            requestTimeoutSeconds: 30,
            mergeRequestTimeoutSeconds: 40,
            fallbackRequestTimeoutSeconds: 50,
        };
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 0, settings)).toBe(30000);
        expect(computeAttemptTimeoutMs({ kind: 'promotion' }, 0, settings)).toBe(40000);
        expect(computeAttemptTimeoutMs({ useFallback: true }, 0, settings)).toBe(50000);
    });

    it('uses fallback timeouts when no setting is finite', () => {
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 0, {})).toBe(120000);
        expect(computeAttemptTimeoutMs({ kind: 'layer0' }, 1, {})).toBe(120000);
        expect(computeAttemptTimeoutMs({ kind: 'promotion' }, 0, {})).toBe(90000);
        expect(computeAttemptTimeoutMs({ kind: 'promotion' }, 1, {})).toBe(90000);
    });
});

describe('classifyAttemptRetryStatus', () => {
    it('reports an aborted result when the signal is aborted', () => {
        expect(classifyAttemptRetryStatus(new Error('anything'), true)).toMatchObject({
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'aborted',
        });
    });

    it('reports an aborted result for the "Aborted by user" message', () => {
        expect(classifyAttemptRetryStatus(new Error('Aborted by user'), false)).toMatchObject({
            aborted: true,
            failureStatus: 'aborted',
        });
    });

    it('reports a hard failover for a hard network error', () => {
        expect(classifyAttemptRetryStatus(new Error('Failed to fetch'), false)).toMatchObject({
            shouldRetry: false,
            hardFailover: true,
            failureStatus: 'hard-failover',
        });
    });

    it('retries a retryable-status failure but refuses a client-error status', () => {
        const retryable = { status: RETRY_CONFIG.retryableStatuses[0], message: 'ignored' };
        expect(classifyAttemptRetryStatus(retryable, false)).toMatchObject({
            shouldRetry: true,
            hardFailover: false,
            failureStatus: 'failed',
        });

        const clientError = { status: 400, message: 'bad request' };
        expect(classifyAttemptRetryStatus(clientError, false)).toMatchObject({
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'failed',
        });
    });
});

describe('isHardNetworkError', () => {
    it('returns false for an error with no message', () => {
        expect(isHardNetworkError({})).toBe(false);
        expect(isHardNetworkError({ message: '' })).toBe(false);
    });

    it.each([
        'Failed to fetch',
        'ECONNREFUSED 127.0.0.1:11434',
        'net::ERR_CONNECTION_REFUSED',
        'net::ERR_NAME_NOT_RESOLVED',
        'net::ERR_INTERNET_DISCONNECTED',
    ])('matches the disconnect substring in %s case-insensitively', (message) => {
        expect(isHardNetworkError({ message })).toBe(true);
    });

    it('returns false for an unrelated message', () => {
        expect(isHardNetworkError({ message: 'invalid API key' })).toBe(false);
    });
});

describe('shouldSwitchToRepairPrompt', () => {
    const base = {
        attemptResult: { shouldRetry: true, failureStatus: 'empty' },
        attempt: 0,
        maxRetries: 3,
        repairPrompt: 'repair',
    };

    it('is true when every condition holds and the status is a validation failure', () => {
        expect(shouldSwitchToRepairPrompt(base)).toBe(true);
    });

    it.each([
        ['no repair prompt', { repairPrompt: '' }],
        ['attempt at max retries', { attempt: 3 }],
        ['result not retryable', { attemptResult: { shouldRetry: false, failureStatus: 'empty' } }],
        [
            'non-validation status',
            { attemptResult: { shouldRetry: true, failureStatus: 'failed' } },
        ],
    ])('is false when %s', (_label, override) => {
        expect(shouldSwitchToRepairPrompt({ ...base, ...override })).toBe(false);
    });
});

describe('getRetryStopReason', () => {
    it('returns hard-failover when the attempt hard-failed', () => {
        expect(getRetryStopReason({ hardFailover: true, shouldRetry: true }, 0, 3)).toBe(
            'hard-failover',
        );
    });

    it('returns non-retryable when the result is not retryable', () => {
        expect(getRetryStopReason({ hardFailover: false, shouldRetry: false }, 0, 3)).toBe(
            'non-retryable',
        );
    });

    it('returns retries-exhausted at the retry ceiling and primary-probe-failed when maxRetries is 0', () => {
        expect(getRetryStopReason({ shouldRetry: true }, 3, 3)).toBe('retries-exhausted');
        expect(getRetryStopReason({ shouldRetry: true }, 0, 0)).toBe('primary-probe-failed');
    });

    it('returns "" while retries remain', () => {
        expect(getRetryStopReason({ shouldRetry: true }, 1, 3)).toBe('');
    });
});

describe('getPrimaryHealthBucket', () => {
    it('routes promotion to a different bucket than layer0/regenerate', () => {
        expect(getPrimaryHealthBucket({ kind: 'promotion' })).not.toBe(
            getPrimaryHealthBucket({ kind: 'layer0' }),
        );
        expect(getPrimaryHealthBucket({ kind: 'regenerate' })).toBe(
            getPrimaryHealthBucket({ kind: 'layer0' }),
        );
        expect(typeof getPrimaryHealthBucket({ kind: 'promotion' })).toBe('string');
    });
});
