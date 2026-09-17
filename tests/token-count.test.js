import { describe, expect, it, vi } from 'vitest';

import {
    addBudgetStats,
    countMessageTokens,
    countTextTokens,
    createBudgetStats,
    formatCompactTokenCount,
    formatTokenCount,
    formatTokenValue,
} from '../src/core/token-count.js';
import { installSummaryContext, makeMessage } from './test-helpers.js';

describe('createBudgetStats', () => {
    it('returns an all-zero stats object with estimate flags false', () => {
        expect(createBudgetStats()).toEqual({
            rawTokens: 0,
            finalTokens: 0,
            savedTokens: 0,
            rawTokensEstimated: false,
            finalTokensEstimated: false,
            savedTokensEstimated: false,
            changedMessageCount: 0,
        });
    });
});

describe('addBudgetStats', () => {
    it('derives savedTokens as rawTokens - finalTokens', () => {
        const stats = createBudgetStats();
        addBudgetStats(stats, {
            rawTokens: 100,
            finalTokens: 40,
            rawTokensEstimated: false,
            finalTokensEstimated: false,
            changed: false,
        });
        expect(stats.rawTokens).toBe(100);
        expect(stats.finalTokens).toBe(40);
        expect(stats.savedTokens).toBe(60);
    });

    it('propagates estimate flags via OR and keeps them true once set', () => {
        const stats = createBudgetStats();
        addBudgetStats(stats, {
            rawTokens: 10,
            finalTokens: 10,
            rawTokensEstimated: true,
            finalTokensEstimated: false,
            changed: false,
        });
        expect(stats.rawTokensEstimated).toBe(true);
        expect(stats.savedTokensEstimated).toBe(true);
        addBudgetStats(stats, {
            rawTokens: 5,
            finalTokens: 5,
            rawTokensEstimated: false,
            finalTokensEstimated: false,
            changed: false,
        });
        expect(stats.rawTokensEstimated).toBe(true);
    });

    it('increments changedMessageCount only when counted.changed is truthy', () => {
        const stats = createBudgetStats();
        addBudgetStats(stats, { rawTokens: 1, finalTokens: 1, changed: false });
        addBudgetStats(stats, { rawTokens: 1, finalTokens: 1, changed: true });
        addBudgetStats(stats, { rawTokens: 1, finalTokens: 1, changed: true });
        expect(stats.changedMessageCount).toBe(2);
    });
});

describe('formatCompactTokenCount', () => {
    it.each([
        [999, '999'],
        [1000, '1k'],
        // Floors toward zero rather than rounding: 1500 -> '1k', not '2k'.
        [1500, '1k'],
        [-1500, '-1k'],
    ])('formats %s as %s', (input, expected) => {
        expect(formatCompactTokenCount(input)).toBe(expected);
    });

    it.each([[NaN], ['x'], [Infinity]])('returns "?" for non-finite input (%s)', (input) => {
        expect(formatCompactTokenCount(input)).toBe('?');
    });
});

describe('formatTokenValue', () => {
    it('prefixes "~" only when estimated is true', () => {
        expect(formatTokenValue(1500, true)).toBe('~1k');
        expect(formatTokenValue(1500, false)).toBe('1k');
    });

    it('returns "?" for a non-finite count', () => {
        expect(formatTokenValue(NaN)).toBe('?');
    });
});

describe('formatTokenCount', () => {
    it('returns "?" for null or a non-finite count', () => {
        expect(formatTokenCount(null)).toBe('?');
        expect(formatTokenCount({ count: NaN })).toBe('?');
    });

    it('formats an exact count without a tilde and an estimated one with a tilde', () => {
        expect(formatTokenCount({ count: 1500, estimated: false })).toBe('1k');
        expect(formatTokenCount({ count: 1500, estimated: true })).toBe('~1k');
    });
});

describe('countTextTokens', () => {
    it('returns the tokenizer count as exact when it is finite', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 42 });
        expect(await countTextTokens('anything')).toEqual({ count: 42, estimated: false });
    });

    it.each([
        ['null tokenizer result', async () => null],
        ['non-finite tokenizer result', async () => NaN],
        [
            'throwing tokenizer',
            async () => {
                throw new Error('tokenizer offline');
            },
        ],
    ])('falls back to an estimate when the tokenizer yields %s', async (_label, stub) => {
        installSummaryContext({ getTokenCountAsync: stub });
        // 40-char string -> ceil(40 / 4) = 10.
        const result = await countTextTokens('x'.repeat(40));
        expect(result).toEqual({ count: 10, estimated: true });
    });

    it('estimates empty text as 0 and a single char as 1', async () => {
        installSummaryContext({ getTokenCountAsync: async () => null });
        expect(await countTextTokens('')).toEqual({ count: 0, estimated: true });
        expect(await countTextTokens('a')).toEqual({ count: 1, estimated: true });
    });

    it('coerces null/undefined text to an empty string (estimated 0)', async () => {
        installSummaryContext({ getTokenCountAsync: async () => null });
        expect(await countTextTokens(null)).toEqual({ count: 0, estimated: true });
        expect(await countTextTokens(undefined)).toEqual({ count: 0, estimated: true });
    });
});

describe('countMessageTokens', () => {
    it('caches on the message and short-circuits a repeat call with the same lines', async () => {
        const getTokenCountAsync = vi.fn(async (text) => String(text).length);
        installSummaryContext({ getTokenCountAsync });
        const message = makeMessage();

        const first = await countMessageTokens(message, 'hello', 'hello');
        expect(message.extra.sc_token_count).toBeTruthy();
        const callsAfterFirst = getTokenCountAsync.mock.calls.length;

        const second = await countMessageTokens(message, 'hello', 'hello');
        // Same combined length -> cache hit, tokenizer not invoked again.
        expect(getTokenCountAsync.mock.calls.length).toBe(callsAfterFirst);
        expect(second).toEqual(first);
    });

    it('recomputes when raw and final lines differ', async () => {
        const getTokenCountAsync = vi.fn(async (text) => String(text).length);
        installSummaryContext({ getTokenCountAsync });
        const message = makeMessage();

        // The identical-lines call counts once (cache test owns the repeat
        // contract); differing raw/final lines each hit the tokenizer.
        await countMessageTokens(message, 'hello', 'hello');
        await countMessageTokens(message, 'raw line', 'final line');
        expect(getTokenCountAsync).toHaveBeenCalledTimes(3);
    });
});
