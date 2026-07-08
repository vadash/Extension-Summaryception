import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const baseSettings = {
    memoryMode: 'cache',
    minSummaryTurns: 10,
    maxSummaryTurns: 1,
    minSummaryBudget: 3000,
    verbatimTokenBudget: 5000,
    applyRegexScripts: false,
};

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

async function getPlan(chat, settings = {}) {
    installSillyTavernStub({
        chat,
        getTokenCountAsync: countMarkedTokens,
    });
    const { getCacheFriendlyPlan } = await import('../src/core/cache-planner.js');
    return await getCacheFriendlyPlan(
        chat,
        { layers: [], summarizedUpTo: -1, ghostedIndices: [] },
        { ...baseSettings, ...settings },
    );
}

function countMarkedTokens(text) {
    const match = String(text).match(/\[(\d+)]/);
    return Promise.resolve(match ? Number(match[1]) : 1);
}

function assistantMessages(count, tokens = 1000) {
    return Array.from({ length: count }, () => makeMessage({ mes: `[${tokens}]` }));
}

describe('cache-friendly planner', () => {
    it('does not flush while live chat stays under the cache budget', async () => {
        const plan = await getPlan(assistantMessages(3), { verbatimTokenBudget: 5000 });

        expect(plan.reason).toBe('none');
        expect(plan.liveTokens).toBe(3000);
        expect(plan.batchTurns).toEqual([]);
    });

    it('calculates the protected tail from the verbatim budget', async () => {
        const { getProtectedTailTokens } = await import('../src/core/cache-planner.js');

        expect(getProtectedTailTokens(16000)).toBe(4000);
        expect(getProtectedTailTokens(32000)).toBe(6000);
        expect(getProtectedTailTokens(64000)).toBe(8000);
    });

    it('leaves the protected tail out of the flush range', async () => {
        const plan = await getPlan(assistantMessages(8), { verbatimTokenBudget: 5000 });

        expect(plan.reason).toBe('ready');
        expect(plan.protectedTailTokens).toBe(4000);
        expect(plan.tailStartIdx).toBe(4);
        expect(plan.flushEndIdx).toBe(3);
        expect(plan.assistantTurns.map((turn) => turn.index)).toEqual([0, 1, 2, 3]);
    });

    it('selects one token-balanced batch from the flushable cache range', async () => {
        const plan = await getPlan(assistantMessages(12), {
            minSummaryBudget: 3000,
            maxSummaryTurns: 3,
            verbatimTokenBudget: 5000,
        });

        expect(plan.reason).toBe('ready');
        expect(plan.estimatedFlushTokens).toBe(8000);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0, 1, 2]);
        expect(
            plan.partitions.map((partition) => partition.turns.map((turn) => turn.index)),
        ).toEqual([
            [0, 1, 2],
            [3, 4, 5],
            [6, 7],
        ]);
        expect(plan.overflowCount).toBe(8);
    });

    it('ignores max turn sliders after the initial cache delay when token balance is safe', async () => {
        const plan = await getPlan(assistantMessages(12), {
            minSummaryTurns: 99,
            maxSummaryTurns: 1,
            minSummaryBudget: 3000,
            verbatimTokenBudget: 5000,
        });

        expect(plan.reason).toBe('ready');
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0, 1, 2]);
        expect(plan.overflowCount).toBe(8);
    });
});
