import { describe, expect, it } from 'vitest';

import { RETRY_CONFIG } from '../src/foundation/retry.js';
import {
    classifyAttemptRetryStatus,
    getRetryStopReason,
    isHardNetworkError,
    shouldSwitchToRepairPrompt,
} from '../src/core/request-retry-policy.js';

describe('classifyAttemptRetryStatus', () => {
    it('reports an aborted result when the signal is aborted', () => {
        expect(classifyAttemptRetryStatus(new Error('anything'), true)).toMatchObject({
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
        });
    });

    it('reports an aborted result for the "Aborted by user" message', () => {
        expect(classifyAttemptRetryStatus(new Error('Aborted by user'), false)).toMatchObject({
            aborted: true,
            shouldRetry: false,
        });
    });

    it('reports a hard failover for a hard network error', () => {
        expect(classifyAttemptRetryStatus(new Error('Failed to fetch'), false)).toMatchObject({
            shouldRetry: false,
            hardFailover: true,
        });
    });

    it('retries a retryable-status failure but refuses a client-error status', () => {
        const retryable = { status: RETRY_CONFIG.retryableStatuses[0], message: 'ignored' };
        expect(classifyAttemptRetryStatus(retryable, false)).toMatchObject({
            shouldRetry: true,
            hardFailover: false,
        });

        const clientError = { status: 400, message: 'bad request' };
        expect(classifyAttemptRetryStatus(clientError, false)).toMatchObject({
            shouldRetry: false,
            hardFailover: false,
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
        attemptResult: { status: 'rejected' },
        attempt: 0,
        maxRetries: 3,
        repairPrompt: 'repair',
    };

    it('is true when every condition holds and the attempt was a rejected output', () => {
        expect(shouldSwitchToRepairPrompt(base)).toBe(true);
    });

    it.each([
        ['no repair prompt', { repairPrompt: '' }],
        ['attempt at max retries', { attempt: 3 }],
        ['result not a rejected output', { attemptResult: { status: 'failed', retryable: true } }],
    ])('is false when %s', (_label, override) => {
        expect(shouldSwitchToRepairPrompt({ ...base, ...override })).toBe(false);
    });
});

describe('getRetryStopReason', () => {
    it('returns hard-failover when the attempt hard-failed', () => {
        expect(getRetryStopReason({ status: 'hard-failover' }, 0, 3)).toBe('hard-failover');
    });

    it('returns non-retryable when the result is not retryable', () => {
        expect(getRetryStopReason({ status: 'failed', retryable: false }, 0, 3)).toBe(
            'non-retryable',
        );
        expect(getRetryStopReason({ status: 'guard-stopped' }, 0, 3)).toBe('non-retryable');
    });

    it('returns retries-exhausted at the retry ceiling and primary-probe-failed when maxRetries is 0', () => {
        expect(getRetryStopReason({ status: 'failed', retryable: true }, 3, 3)).toBe(
            'retries-exhausted',
        );
        expect(getRetryStopReason({ status: 'rejected' }, 3, 3)).toBe('retries-exhausted');
        expect(getRetryStopReason({ status: 'failed', retryable: true }, 0, 0)).toBe(
            'primary-probe-failed',
        );
    });

    it('returns "" while retries remain', () => {
        expect(getRetryStopReason({ status: 'failed', retryable: true }, 1, 3)).toBe('');
        expect(getRetryStopReason({ status: 'rejected' }, 1, 3)).toBe('');
    });
});
