import { describe, expect, it } from 'vitest';

import {
    SUMMARY_COMMIT_MODES,
    SUMMARY_ROUTES,
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
    describeAutoWork,
} from '../src/core/summarization-routes.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';
import {
    makeSizedChat,
    makeSummarySettings,
    makeSummaryStore,
    readySettings,
} from './test-helpers.js';

describe('buildAutoSummaryRoutePlan', () => {
    it.each([
        [MEMORY_MODES.BALANCED, SUMMARY_ROUTES.STANDARD_AUTO, SUMMARY_COMMIT_MODES.TURNS],
        [
            MEMORY_MODES.PREFIX_CACHE,
            SUMMARY_ROUTES.CACHE_AUTO,
            SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS,
        ],
    ])('uses one recent/queued readiness result for %s', async (mode, route, commitMode) => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildAutoSummaryRoutePlan(chat, makeSummaryStore(), readySettings(mode));
        expect(plan.route).toBe(route);
        expect(plan.commitMode).toBe(commitMode);
        expect(plan.reason).toBe('ready');
        expect(plan.ready).toBe(true);
    });

    it('Balanced routes only the first partition', async () => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.BALANCED),
        );
        expect(plan.partitions).toHaveLength(2);
        expect(plan.batchTurns).toBe(plan.partitions[0].turns);
        expect(plan.batchTurns.length).toBeLessThan(plan.overflowCount);
        expect(plan.totalBatches).toBe(1);
    });

    it.each([MEMORY_MODES.PREFIX_CACHE])('%s routes one oldest partition per run', async (mode) => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildAutoSummaryRoutePlan(chat, makeSummaryStore(), readySettings(mode));
        expect(plan.partitions).toHaveLength(1);
        expect(plan.totalBatches).toBe(1);
        expect(plan.partitions[0].turns.length).toBeLessThan(plan.overflowCount);
    });

    it('stays idle below Recent + Queued despite max turns', async () => {
        const chat = makeSizedChat(8, { userLength: 20, assistantLength: 60 });
        const plan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            makeSummarySettings({
                memoryMode: MEMORY_MODES.BALANCED,
                verbatimTokenBudget: 10000,
                queuedTokenBudget: 10000,
                maxSummaryTurns: 2,
            }),
        );
        expect(plan.reason).toBe('none');
        expect(plan.ready).toBe(false);
    });
});

describe('buildForceSummaryRoutePlan', () => {
    it('summarizes the queued block while preserving Recent Chat', async () => {
        const settings = readySettings(MEMORY_MODES.BALANCED);
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildForceSummaryRoutePlan(chat, makeSummaryStore(), settings);
        expect(plan.reason).toBe('force');
        expect(plan.ready).toBe(true);
        expect(plan.targetIndex).toBeGreaterThan(0);
        expect(plan.batchTurns.every((turn) => turn.index < plan.targetIndex)).toBe(true);
        expect(plan.batchTurns.length).toBeLessThan(plan.visibleTurnCount);
        expect(plan.visibleTurnCount).toBeGreaterThan(0);
        expect(plan.tokenStats.partitionCount).toBe(plan.partitions.length);
        expect(plan.tokenStats.verbatimBudget).toBe(settings.verbatimTokenBudget);
        expect(plan.tokenStats.queuedBudget).toBe(settings.queuedTokenBudget);
    });

    it('stays idle on empty chat', async () => {
        const plan = await buildForceSummaryRoutePlan(
            [],
            makeSummaryStore(),
            makeSummarySettings(),
        );
        expect(plan.reason).toBe('none');
        expect(plan.ready).toBe(false);
    });
});
describe('describeAutoWork', () => {
    it('reports ready backlog and token scalars for eligible work', async () => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const work = await describeAutoWork(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.BALANCED),
        );
        expect(work.ready).toBe(true);
        expect(work.backlog).toBeGreaterThan(0);
        expect(work.verbatimTokens).toBeGreaterThan(0);
        expect(work.queuedTokens).toBeGreaterThan(0);
    });

    it('reports zero backlog and zero tokens without eligible work', async () => {
        const work = await describeAutoWork([], makeSummaryStore(), makeSummarySettings());
        expect(work.ready).toBe(false);
        expect(work.backlog).toBe(0);
        expect(work.verbatimTokens).toBe(0);
        expect(work.verbatimEstimated).toBe(false);
        expect(work.queuedTokens).toBe(0);
        expect(work.queuedEstimated).toBe(false);
    });
});
