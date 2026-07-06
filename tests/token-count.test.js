import { describe, expect, it } from 'vitest';
import { addBudgetStats, createBudgetStats } from '../src/core/token-count.js';

describe('budget token stats', () => {
    it('creates an empty budget stats aggregate', () => {
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

    it('accumulates token counts, estimate flags, and changed message count', () => {
        const stats = createBudgetStats();

        addBudgetStats(stats, {
            rawTokens: 100,
            finalTokens: 70,
            rawTokensEstimated: false,
            finalTokensEstimated: true,
            changed: true,
        });
        addBudgetStats(stats, {
            rawTokens: 20,
            finalTokens: 25,
            rawTokensEstimated: true,
            finalTokensEstimated: false,
            changed: false,
        });

        expect(stats).toEqual({
            rawTokens: 120,
            finalTokens: 95,
            savedTokens: 25,
            rawTokensEstimated: true,
            finalTokensEstimated: true,
            savedTokensEstimated: true,
            changedMessageCount: 1,
        });
    });
});
