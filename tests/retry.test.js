import { describe, it, expect, vi, afterEach } from 'vitest';
import { sleep, parseRetryAfter, isRetryableError, RETRY_CONFIG } from '../src/foundation/retry.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('sleep', () => {
    it('resolves after at least the requested duration', async () => {
        vi.useFakeTimers();
        const start = Date.now();
        const p = sleep(2000);
        vi.advanceTimersByTime(2000);
        await p;
        expect(Date.now() - start).toBe(2000);
    });
});

describe('parseRetryAfter', () => {
    it('returns null when no retry-after information is present', () => {
        expect(parseRetryAfter(new Error('boom'))).toBeNull();
    });

    it('parses a numeric retry-after header into ms', () => {
        const err = { response: { headers: { 'retry-after': '3' } } };
        expect(parseRetryAfter(err)).toBe(3000);
    });

    it('parses an HTTP-date retry-after header and floors negative values to 0', () => {
        const past = new Date(Date.now() - 5000).toUTCString();
        const err = { retryAfter: past };
        expect(parseRetryAfter(err)).toBe(0);
    });

    it('returns null when header is non-numeric and unparseable', () => {
        const err = { data: { retry_after: 'not-a-date-or-number' } };
        expect(parseRetryAfter(err)).toBeNull();
    });
});

describe('isRetryableError', () => {
    it('never retries an AbortError', () => {
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        expect(isRetryableError(abort)).toBe(false);
    });

    it('still treats a plain generic Error as non-retryable', () => {
        expect(isRetryableError(new Error('completely unrelated'))).toBe(false);
    });

    it('honors ConnectionError.retryable=false as non-retryable', () => {
        const err = new Error('fatal');
        err.name = 'ConnectionError';
        err.retryable = false;
        expect(isRetryableError(err)).toBe(false);
    });

    it('honors ConnectionError.retryable=true as retryable', () => {
        const err = new Error('transient');
        err.name = 'ConnectionError';
        err.retryable = true;
        expect(isRetryableError(err)).toBe(true);
    });

    it('retries network-fetch TypeErrors', () => {
        const err = new TypeError('fetch failed');
        expect(isRetryableError(err)).toBe(true);
    });

    it('maps retryable HTTP statuses to retryable', () => {
        for (const status of RETRY_CONFIG.retryableStatuses) {
            expect(isRetryableError({ status })).toBe(true);
        }
    });

    it('treats a 404 as non-retryable', () => {
        expect(isRetryableError({ status: 404 })).toBe(false);
    });

    it('detects transient failures by lowercase message content', () => {
        expect(isRetryableError(new Error('Too Many Requests'))).toBe(true);
        expect(isRetryableError(new Error('Server Error: boom'))).toBe(true);
        expect(isRetryableError(new Error('timeout'))).toBe(true);
        expect(isRetryableError(new Error('Request timed out after 120s'))).toBe(true);
        expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
        expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
        expect(isRetryableError(new Error('network error'))).toBe(true);
        expect(isRetryableError(new Error('overloaded'))).toBe(true);
        expect(isRetryableError(new Error('at capacity'))).toBe(true);
        expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    });
});
