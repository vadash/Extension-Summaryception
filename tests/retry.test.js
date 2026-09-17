import { describe, expect, it } from 'vitest';

import { RETRY_CONFIG, isRetryableError, parseRetryAfter } from '../src/foundation/retry.js';

describe('parseRetryAfter', () => {
    it('converts a numeric retry-after header string to milliseconds', () => {
        expect(parseRetryAfter({ response: { headers: { 'retry-after': '3' } } })).toBe(3000);
    });

    it('prefers the response header over the top-level retryAfter field', () => {
        const error = {
            response: { headers: { 'retry-after': '3' } },
            retryAfter: '5',
        };
        expect(parseRetryAfter(error)).toBe(3000);
    });

    it('clamps a past HTTP-date to a non-negative wait of 0', () => {
        const result = parseRetryAfter({
            response: { headers: { 'retry-after': 'Wed, 01 Jan 2020 00:00:00 GMT' } },
        });
        expect(result).toBe(0);
    });

    it('returns null when no retry-after signal is present or it is unparseable', () => {
        expect(parseRetryAfter({})).toBeNull();
        expect(parseRetryAfter(null)).toBeNull();
        // 'not-a-date' fails both Number() and Date parsing branches.
        expect(parseRetryAfter({ retryAfter: 'not-a-date' })).toBeNull();
    });
});

describe('isRetryableError', () => {
    it('returns false for an AbortError even when its message looks retryable', () => {
        expect(isRetryableError({ name: 'AbortError', message: 'timeout' })).toBe(false);
    });

    it('honors an explicit ConnectionError.retryable boolean', () => {
        expect(isRetryableError({ name: 'ConnectionError', retryable: true })).toBe(true);
        // retryable:false wins even with a retryable-looking message.
        expect(
            isRetryableError({ name: 'ConnectionError', retryable: false, message: 'timeout' }),
        ).toBe(false);
    });

    it('classifies a fetch TypeError as retryable', () => {
        expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
    });

    it('classifies an HTTP status from RETRY_CONFIG.retryableStatuses as retryable on every lookup path', () => {
        // Derive the status from the module's own list; never hardcode the literal.
        const status = RETRY_CONFIG.retryableStatuses[0];
        expect(Number.isFinite(status)).toBe(true);
        expect(isRetryableError({ status })).toBe(true);
        expect(isRetryableError({ response: { status } })).toBe(true);
        expect(isRetryableError({ statusCode: status })).toBe(true);
    });

    it('matches retryable message patterns case-insensitively and rejects unrelated messages', () => {
        expect(isRetryableError({ message: 'Rate limit exceeded' })).toBe(true);
        expect(isRetryableError({ message: 'invalid API key' })).toBe(false);
    });
});
