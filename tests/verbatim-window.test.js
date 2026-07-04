import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    applyRegexToMessage: vi.fn(),
}));

vi.mock('../src/core/regex-proxy.js', () => ({
    applyRegexToMessage: mocks.applyRegexToMessage,
}));

const baseSettings = {
    minSummaryTurns: 3,
    maxSummaryTurns: 5,
    minSummaryBudget: 6000,
    verbatimTokenBudget: 16000,
    applyRegexScripts: false,
};

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.applyRegexToMessage.mockImplementation(async (text) => text);
});

async function getPlan(chat, settings = {}) {
    installSillyTavernStub({
        chat,
        getTokenCountAsync: async (text) => text.length,
    });
    const { getLayer0OverflowPlan } = await import('../src/core/verbatim-window.js');
    return await getLayer0OverflowPlan(
        chat,
        { summarizedUpTo: -1 },
        { ...baseSettings, ...settings },
    );
}

describe('getLayer0OverflowPlan', () => {
    it('counts user messages when locating the soft token boundary', async () => {
        const long = 'x'.repeat(1000);
        const chat = [
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
            makeMessage({ isUser: true, mes: long, name: 'Player' }),
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
        ];

        const plan = await getPlan(chat, {
            minSummaryTurns: 2,
            minSummaryBudget: 1000,
            verbatimTokenBudget: 2200,
        });

        expect(plan.reason).toBe('budget');
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0, 1]);
    });

    it('waits for the minimum assistant turns on soft token overflow', async () => {
        const long = 'x'.repeat(1000);
        const chat = [
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
        ];

        const plan = await getPlan(chat, {
            minSummaryTurns: 3,
            minSummaryBudget: 1000,
            verbatimTokenBudget: 2200,
        });

        expect(plan.reason).toBe('none');
        expect(plan.softOverflowCount).toBe(2);
    });

    it('uses the max summary turn cap when overflow tokens are still below the summary budget', async () => {
        const chat = Array.from({ length: 6 }, (_, i) => makeMessage({ mes: `turn ${i}` }));

        const plan = await getPlan(chat, {
            maxSummaryTurns: 5,
            minSummaryBudget: 16000,
            verbatimTokenBudget: 10,
        });

        expect(plan.reason).toBe('max');
        expect(plan.batchTurns).toHaveLength(5);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0, 1, 2, 3, 4]);
    });

    it('uses regex-adjusted token counts for the budget decision', async () => {
        mocks.applyRegexToMessage.mockResolvedValue('ok');
        const long = 'x'.repeat(2000);
        const chat = [
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
            makeMessage({ mes: long }),
        ];

        const plan = await getPlan(chat, {
            applyRegexScripts: true,
            minSummaryTurns: 2,
            minSummaryBudget: 100,
            verbatimTokenBudget: 100,
        });

        expect(plan.reason).toBe('none');
        expect(plan.budgetStats.savedTokens).toBeGreaterThan(0);
        expect(plan.tokenBudgetExceeded).toBe(false);
    });

    it('selects assistant endpoints cleanly through irregular user and assistant ordering', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'u0', name: 'Player' }),
            makeMessage({ mes: 'b1' }),
            makeMessage({ mes: 'b2' }),
            makeMessage({ isUser: true, mes: 'u3', name: 'Player' }),
            makeMessage({ isUser: true, mes: 'u4', name: 'Player' }),
            makeMessage({ mes: 'b5' }),
            makeMessage({ mes: 'b6' }),
        ];

        const plan = await getPlan(chat, {
            minSummaryTurns: 2,
            maxSummaryTurns: 3,
            minSummaryBudget: 1,
            verbatimTokenBudget: 20,
        });

        expect(plan.reason).toBe('max');
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1, 2, 5]);
    });
});
