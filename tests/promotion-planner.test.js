import { describe, expect, it } from 'vitest';

import { INTERNAL_MAX_LAYER_DEPTH } from '../src/foundation/constants.js';
import {
    buildHypotheticalLayersAfterPromotion,
    buildPromotionPlan,
} from '../src/core/promotion-planner.js';
import { makeSummarySettings, makeSummaryStore } from './test-helpers.js';

/**
 * The setup context installs a length-based test tokenizer, so the expected
 * token counts below are string lengths of the assembled chronology.
 */

const CHRONOLOGY_HEADER = '[CHRONOLOGY]\n';

function snip(text) {
    return { text };
}

function totalTokens(layers) {
    const active = layers.filter((layer) => Array.isArray(layer) && layer.length > 0);
    return `${CHRONOLOGY_HEADER}${active.map((layer) => layer.map((s) => s.text.trim()).join('\n')).join('\n')}`
        .length;
}

describe('buildPromotionPlan', () => {
    it('builds quotas for active non-empty layers at the initial ratios', async () => {
        const shallow = [snip('x'.repeat(40)), snip('x'.repeat(40))];
        const deep = [snip('x'.repeat(40))];
        const store = makeSummaryStore({ layers: [shallow, deep] });
        const settings = makeSummarySettings({ memoryTokenBudget: 10000 });

        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 6000,
                    tokens: 81,
                    count: 2,
                    totalTokens: 135,
                    tokenBudgetExceeded: false,
                },
                {
                    layerIndex: 1,
                    quota: 3000,
                    tokens: 40,
                    count: 1,
                    totalTokens: 135,
                    tokenBudgetExceeded: false,
                },
            ],
            mergeCount: 3,
            candidate: null,
            retentionFloorViolated: false,
        });
        expect(totalTokens([shallow, deep])).toBe(135);
    });

    it('drops the Layer 0 quota and skips empty layers when deep layers are active', async () => {
        const shallow = [snip('x'.repeat(40))];
        const deepest = [snip('x'.repeat(40))];
        const store = makeSummaryStore({ layers: [shallow, [], deepest] });
        const settings = makeSummarySettings({ memoryTokenBudget: 10000 });

        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 5000,
                    tokens: 40,
                    count: 1,
                    totalTokens: 94,
                    tokenBudgetExceeded: false,
                },
                {
                    layerIndex: 2,
                    quota: 2000,
                    tokens: 40,
                    count: 1,
                    totalTokens: 94,
                    tokenBudgetExceeded: false,
                },
            ],
            mergeCount: 3,
            candidate: null,
            retentionFloorViolated: false,
        });
        expect(totalTokens([shallow, [], deepest])).toBe(94);
    });

    it('returns no quotas for an empty store', async () => {
        const store = makeSummaryStore();

        await expect(buildPromotionPlan(store, makeSummarySettings())).resolves.toEqual({
            quotas: [],
            mergeCount: 3,
            candidate: null,
            retentionFloorViolated: false,
        });
    });

    it('clamps a non-finite merge count to the minimum', async () => {
        const store = makeSummaryStore();
        const settings = makeSummarySettings({ snippetsPerPromotion: Number.NaN });

        await expect(buildPromotionPlan(store, settings)).resolves.toMatchObject({
            mergeCount: 3,
        });
    });

    it('rounds and clamps the merge count into the 3..4 band', async () => {
        const store = makeSummaryStore();

        await expect(
            buildPromotionPlan(store, makeSummarySettings({ snippetsPerPromotion: 2 })),
        ).resolves.toMatchObject({ mergeCount: 3 });
        await expect(
            buildPromotionPlan(store, makeSummarySettings({ snippetsPerPromotion: 3.6 })),
        ).resolves.toMatchObject({ mergeCount: 4 });
        await expect(
            buildPromotionPlan(store, makeSummarySettings({ snippetsPerPromotion: 99 })),
        ).resolves.toMatchObject({ mergeCount: 4 });
    });

    it('selects the shallowest over-limit layer as the candidate', async () => {
        const long = 'x'.repeat(2000);
        const layer0 = Array.from({ length: 25 }, () => snip('x'.repeat(200)));
        const layer1 = Array.from({ length: 5 }, () => snip(long));
        const store = makeSummaryStore({ layers: [layer0, layer1] });
        const settings = makeSummarySettings({ memoryTokenBudget: 10000 });

        // Layer 0 exceeds the count limit (25 > 24). Layer 1 exceeds its token quota (10004 > 3000).
        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 6000,
                    tokens: 5024,
                    count: 25,
                    totalTokens: 15042,
                    tokenBudgetExceeded: true,
                },
                {
                    layerIndex: 1,
                    quota: 3000,
                    tokens: 10004,
                    count: 5,
                    totalTokens: 15042,
                    tokenBudgetExceeded: true,
                },
            ],
            mergeCount: 3,
            candidate: { layerIndex: 0, quota: 6000, tokens: 5024, count: 25 },
            retentionFloorViolated: false,
        });
    });

    it('selects a deeper layer when every shallow layer fits', async () => {
        const layer0 = [snip('x'.repeat(200)), snip('x'.repeat(200))];
        const layer1 = Array.from({ length: 5 }, () => snip('x'.repeat(2000)));
        const store = makeSummaryStore({ layers: [layer0, layer1] });
        const settings = makeSummarySettings({ memoryTokenBudget: 10000 });

        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 6000,
                    tokens: 401,
                    count: 2,
                    totalTokens: 10419,
                    tokenBudgetExceeded: true,
                },
                {
                    layerIndex: 1,
                    quota: 3000,
                    tokens: 10004,
                    count: 5,
                    totalTokens: 10419,
                    tokenBudgetExceeded: true,
                },
            ],
            mergeCount: 3,
            candidate: { layerIndex: 1, quota: 3000, tokens: 10004, count: 5 },
            retentionFloorViolated: false,
        });
    });

    it('skips an over-limit layer at the internal depth cap', async () => {
        const layers = Array.from({ length: INTERNAL_MAX_LAYER_DEPTH }, () => []);
        layers[0] = [snip('x'.repeat(200)), snip('x'.repeat(200))];
        layers[INTERNAL_MAX_LAYER_DEPTH - 1] = Array.from({ length: 5 }, () =>
            snip('x'.repeat(2000)),
        );
        const store = makeSummaryStore({ layers });
        const settings = makeSummarySettings({ memoryTokenBudget: 10000 });

        const plan = await buildPromotionPlan(store, settings);

        expect(plan.candidate).toBeNull();
        expect(plan.retentionFloorViolated).toBe(false);
        expect(plan.quotas.at(-1)).toMatchObject({
            layerIndex: INTERNAL_MAX_LAYER_DEPTH - 1,
            quota: 2000,
            count: 5,
        });
    });

    it('keeps a token-exceeded layer as the candidate when it holds enough snippets', async () => {
        const heavy = 'memory detail '.repeat(20);
        const layer0 = Array.from({ length: 4 }, () => snip(heavy));
        const store = makeSummaryStore({ layers: [layer0] });
        const settings = makeSummarySettings({ memoryTokenBudget: 40 });

        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 24,
                    tokens: 1119,
                    count: 4,
                    totalTokens: 1132,
                    tokenBudgetExceeded: true,
                },
            ],
            mergeCount: 3,
            candidate: { layerIndex: 0, quota: 24, tokens: 1119, count: 4 },
            retentionFloorViolated: false,
        });
    });

    it('returns a null candidate when a token-heavy layer lacks the minimum merge count', async () => {
        const heavy = 'memory detail '.repeat(20);
        const layer0 = [snip(heavy), snip(heavy)];
        const store = makeSummaryStore({ layers: [layer0] });
        const settings = makeSummarySettings({ memoryTokenBudget: 40 });

        await expect(buildPromotionPlan(store, settings)).resolves.toEqual({
            quotas: [
                {
                    layerIndex: 0,
                    quota: 24,
                    tokens: 559,
                    count: 2,
                    totalTokens: 572,
                    tokenBudgetExceeded: true,
                },
            ],
            mergeCount: 3,
            candidate: null,
            retentionFloorViolated: false,
        });
    });

    it('flags the retention floor only for a Layer 0 candidate that would breach it', async () => {
        // Removing 3 of 25 snippets leaves 22 x 200 chars = 4421 tokens >= floor 2400.
        const keeping = Array.from({ length: 25 }, () => snip('x'.repeat(200)));
        const settled = await buildPromotionPlan(
            makeSummaryStore({ layers: [keeping] }),
            makeSummarySettings({ memoryTokenBudget: 10000 }),
        );
        expect(settled.candidate).toMatchObject({ layerIndex: 0, count: 25 });
        expect(settled.retentionFloorViolated).toBe(false);

        // Removing 3 of 5 snippets leaves 401 tokens < floor 2400.
        const breaching = Array.from({ length: 5 }, () => snip('x'.repeat(200)));
        const breached = await buildPromotionPlan(
            makeSummaryStore({ layers: [breaching] }),
            makeSummarySettings({ memoryTokenBudget: 10000, snippetsPerLayer: 4 }),
        );
        expect(breached.candidate).toEqual({ layerIndex: 0, quota: 6000, tokens: 1004, count: 5 });
        expect(breached.retentionFloorViolated).toBe(true);
    });
});

describe('buildHypotheticalLayersAfterPromotion', () => {
    const a = { text: 'a' };
    const b = { text: 'b' };
    const c = { text: 'c' };
    const d = { text: 'd' };
    const existing = { text: 'older' };
    const promoted = { text: 'promoted' };

    it('splices the merged snippets and pushes the promotion into the next layer', () => {
        const layers = [[a, b, c, d], [existing]];

        const result = buildHypotheticalLayersAfterPromotion(layers, 0, 2, promoted);

        expect(result).toEqual([
            [c, d],
            [existing, promoted],
        ]);
        expect(layers).toEqual([[a, b, c, d], [existing]]);
        expect(result[0]).not.toBe(layers[0]);
        expect(result[1]).not.toBe(layers[1]);
    });

    it('splices without appending when no promoted snippet is given', () => {
        const layers = [[a, b, c, d], [existing]];

        expect(buildHypotheticalLayersAfterPromotion(layers, 0, 2)).toEqual([[c, d], [existing]]);
    });

    it('creates the destination layer when it does not exist yet', () => {
        const layers = [[a, b, c]];

        expect(buildHypotheticalLayersAfterPromotion(layers, 0, 2, promoted)).toEqual([
            [c],
            [promoted],
        ]);
    });

    it('returns a fresh structure for a non-array layers input', () => {
        expect(buildHypotheticalLayersAfterPromotion(null, 0, 2, promoted)).toEqual([
            [],
            [promoted],
        ]);
    });
});
