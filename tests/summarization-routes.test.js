import { describe, expect, it } from 'vitest';

import {
    SUMMARY_COMMIT_MODES,
    SUMMARY_ROUTES,
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
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

    it.each([MEMORY_MODES.PREFIX_CACHE])('%s routes every B partition atomically', async (mode) => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildAutoSummaryRoutePlan(chat, makeSummaryStore(), readySettings(mode));
        expect(plan.partitions).toHaveLength(2);
        expect(plan.totalBatches).toBe(plan.partitions.length);
        expect(plan.partitions.flatMap((part) => part.turns)).toHaveLength(plan.overflowCount);
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
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildForceSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.BALANCED),
        );
        expect(plan.reason).toBe('force');
        expect(plan.ready).toBe(true);
        expect(plan.rawPlan.verbatimStartIdx).toBeGreaterThan(0);
        expect(plan.batchTurns.every((turn) => turn.index < plan.rawPlan.verbatimStartIdx)).toBe(
            true,
        );
        expect(plan.batchTurns.length).toBeLessThan(plan.rawPlan.visibleTurnCount);
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
