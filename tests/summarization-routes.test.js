import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const baseSettings = {
    memoryMode: 'standard',
    minSummaryTurns: 2,
    maxSummaryTurns: 2,
    minSummaryBudget: 1,
    maxL0SourceTokens: 4000,
    verbatimTokenBudget: 20,
    applyRegexScripts: false,
};

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function installRouteContext(chat) {
    installSillyTavernStub({
        chat,
        getTokenCountAsync: async (text) => String(text || '').length,
    });
}

describe('summary route adapter', () => {
    it('normalizes standard auto plans to turn commits', async () => {
        const chat = [
            makeMessage({ mes: 'assistant source 1' }),
            makeMessage({ mes: 'assistant source 2' }),
            makeMessage({ mes: 'latest assistant' }),
        ];
        installRouteContext(chat);
        const { buildAutoSummaryRoutePlan, SUMMARY_COMMIT_MODES, SUMMARY_ROUTES } =
            await import('../src/core/summarization-routes.js');

        const plan = await buildAutoSummaryRoutePlan(chat, { summarizedUpTo: -1 }, baseSettings);

        expect(plan).toMatchObject({
            route: SUMMARY_ROUTES.STANDARD_AUTO,
            ready: true,
            commitMode: SUMMARY_COMMIT_MODES.TURNS,
            phase: 'layer0',
        });
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0, 1]);
    });

    it('normalizes cache auto plans to atomic partition commits', async () => {
        const chat = Array.from({ length: 8 }, () => makeMessage({ mes: 'x'.repeat(1000) }));
        installRouteContext(chat);
        const { buildAutoSummaryRoutePlan, SUMMARY_COMMIT_MODES, SUMMARY_ROUTES } =
            await import('../src/core/summarization-routes.js');

        const plan = await buildAutoSummaryRoutePlan(
            chat,
            { summarizedUpTo: -1 },
            {
                ...baseSettings,
                memoryMode: 'cache',
                maxSummaryTurns: 1,
                minSummaryBudget: 3000,
                verbatimTokenBudget: 5000,
            },
        );

        expect(plan).toMatchObject({
            route: SUMMARY_ROUTES.CACHE_AUTO,
            ready: true,
            commitMode: SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS,
            phase: 'layer0',
        });
        expect(plan.partitions.length).toBeGreaterThan(0);
        expect(plan.overflowCount).toBeGreaterThan(0);
    });

    it('normalizes force plans below normal readiness', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'u0', name: 'Player' }),
            makeMessage({ mes: 'a1' }),
            makeMessage({ isUser: true, mes: 'u2', name: 'Player' }),
            makeMessage({ mes: 'a3' }),
        ];
        installRouteContext(chat);
        const { buildForceSummaryRoutePlan, SUMMARY_COMMIT_MODES, SUMMARY_ROUTES } =
            await import('../src/core/summarization-routes.js');

        const plan = await buildForceSummaryRoutePlan(
            chat,
            { summarizedUpTo: -1 },
            {
                ...baseSettings,
                minSummaryTurns: 3,
                minSummaryBudget: 16000,
                verbatimTokenBudget: 24,
            },
        );

        expect(plan).toMatchObject({
            route: SUMMARY_ROUTES.FORCE,
            ready: true,
            commitMode: SUMMARY_COMMIT_MODES.TURNS,
        });
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1]);
    });

    it('normalizes slop plans to source-end commits', async () => {
        const chat = [
            makeMessage({ mes: 'assistant source' }),
            makeMessage({ isUser: true, mes: 'trailing user', name: 'Player' }),
        ];
        installRouteContext(chat);
        const { buildSlopSummaryRoutePlan, SUMMARY_COMMIT_MODES, SUMMARY_ROUTES } =
            await import('../src/core/summarization-routes.js');

        const plan = await buildSlopSummaryRoutePlan(chat, { summarizedUpTo: -1 }, baseSettings);

        expect(plan).toMatchObject({
            route: SUMMARY_ROUTES.SLOP,
            ready: true,
            commitMode: SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END,
            sourceEndIdx: 0,
            targetIndex: 0,
        });
    });
});
