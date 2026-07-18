import { describe, expect, it } from 'vitest';
import { getEffectiveMemoryUsage } from '../src/core/memory-budget.js';
import {
    buildContextBudgetViewModel,
    buildSnippetBrowserViewModel,
    buildTriggerGaugeModel,
    formatBudgetTokenLabel,
    getSnippetBrowserRowKey,
} from '../src/entry/ui.js';
import { installSillyTavernStub, makeSummaryStore, countTokens } from './test-helpers.js';

describe('snippet browser view model', () => {
    it('marks an empty store as empty', () => {
        const view = buildSnippetBrowserViewModel({
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        });

        expect(view).toEqual({ empty: true, layers: [] });
    });

    it('builds non-empty layers deepest first with row keys and metadata', () => {
        const view = buildSnippetBrowserViewModel({
            layers: [
                [
                    { text: 'turn summary', turnRange: [0, 2] },
                    { text: 'seeded summary', promoted: true },
                ],
                [],
                [{ text: 'meta summary', mergedCount: 3, fromLayer: 1, promoted: true }],
            ],
            summarizedUpTo: 2,
            ghostedIndices: [0, 1, 2],
        });

        expect(view.empty).toBe(false);
        expect(view.layers.map((layer) => layer.index)).toEqual([2, 0]);
        expect(view.layers[0]).toMatchObject({
            key: 'layer:2',
            label: 'Layer 2 (Meta-Summary)',
            snippets: [
                {
                    key: getSnippetBrowserRowKey(2, 0),
                    text: 'meta summary',
                    meta: 'merged 3 from L1 promoted',
                    canRedo: false,
                },
            ],
        });
        expect(view.layers[1].snippets).toEqual([
            {
                key: getSnippetBrowserRowKey(0, 0),
                layerIndex: 0,
                snippetIndex: 0,
                text: 'turn summary',
                meta: 'turns 0-2',
                canRedo: true,
            },
            {
                key: getSnippetBrowserRowKey(0, 1),
                layerIndex: 0,
                snippetIndex: 1,
                text: 'seeded summary',
                meta: ' promoted',
                canRedo: false,
            },
        ]);
    });
});

describe('context budget view model', () => {
    it('shows verbatim usage and free space when no memory layers exist', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 8000),
            layers: [],
        });

        expect(view.used).toBe(8000);
        expect(view.overage).toBe(0);
        expect(view.totalLabel).toBe('8k / 16k');
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Verbatim Window', 'verbatim', 8000],
            ['Free Space', 'free', 8000],
        ]);
    });

    it('keeps layer segments in Layer 0 to deeper-layer order', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 8000),
            layers: [budgetPart('Layer 0', 'layer0', 2000), budgetPart('Layer 1', 'layer', 1000)],
        });

        expect(view.used).toBe(11000);
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Verbatim Window', 'verbatim', 8000],
            ['Layer 0', 'layer0', 2000],
            ['Layer 1', 'layer', 1000],
            ['Free Space', 'free', 5000],
        ]);
    });

    it('includes wrapper overhead when injection tokens exceed layer tokens', () => {
        const view = buildContextBudgetViewModel({
            budget: 10000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 4000),
            layers: [budgetPart('Layer 0', 'layer0', 2000), budgetPart('Layer 1', 'layer', 1000)],
            wrapper: budgetPart('Memory Wrapper', 'wrapper', 200),
        });

        expect(view.used).toBe(7200);
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Verbatim Window', 'verbatim', 4000],
            ['Layer 0', 'layer0', 2000],
            ['Layer 1', 'layer', 1000],
            ['Memory Wrapper', 'wrapper', 200],
            ['Free Space', 'free', 2800],
        ]);
    });

    it('reports overage and omits free space when usage exceeds the budget', () => {
        const view = buildContextBudgetViewModel({
            budget: 5000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 4000),
            layers: [budgetPart('Layer 0', 'layer0', 2000)],
        });

        expect(view.used).toBe(6000);
        expect(view.overage).toBe(1000);
        expect(view.denominator).toBe(6000);
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Verbatim Window', 'verbatim', 4000],
            ['Layer 0', 'layer0', 2000],
        ]);
    });

    it('extends the denominator to the marker and rescales segment percents', () => {
        const view = buildContextBudgetViewModel({
            budget: 10000,
            verbatim: budgetPart('Queued', 'pending', 5000),
            layers: [],
            marker: { positionTokens: 20000, label: 'Trigger: tokens' },
        });

        expect(view.denominator).toBe(20000);
        expect(view.marker).toEqual({ percent: 100, label: 'Trigger: tokens' });
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Queued', 'pending', 5000],
            ['Free Space', 'free', 5000],
        ]);
        expect(view.segments[0].percent).toBe(25);
    });

    it('places the marker at its share of the denominator', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: budgetPart('Queued', 'pending', 4000),
            layers: [],
            marker: { positionTokens: 12000, label: 'Trigger: 3 turns' },
        });

        expect(view.denominator).toBe(16000);
        expect(view.marker).toEqual({ percent: 75, label: 'Trigger: 3 turns' });
    });

    it('omits the marker when none is supplied', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 8000),
            layers: [],
        });

        expect(view.marker).toBeNull();
        expect(view.segments.map(segmentSummary)).toEqual([
            ['Verbatim Window', 'verbatim', 8000],
            ['Free Space', 'free', 8000],
        ]);
    });

    it('preserves estimated token labels', () => {
        const view = buildContextBudgetViewModel({
            budget: 10000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 1000, true),
            layers: [],
        });

        expect(formatBudgetTokenLabel(950, true)).toBe('~950');
        expect(formatBudgetTokenLabel(1000, true)).toBe('~1k');
        expect(formatBudgetTokenLabel(1234567)).toBe('1234k');
        expect(formatBudgetTokenLabel(1356092)).toBe('1356k');
        expect(view.totalLabel).toBe('~1k / 10k');
        expect(view.segments[0].estimated).toBe(true);
    });

    it('can render memory usage from effective injection parts instead of raw snippets', async () => {
        const layers = [
            [
                {
                    text: '[NARRATIVE]\nalpha\n\n[STATE]\nlocation: ' + 'dock '.repeat(20),
                },
                {
                    text: '[NARRATIVE]\nbeta\n\n[STATE]\nlocation: ' + 'tower '.repeat(20),
                },
                {
                    text: '[NARRATIVE]\ngamma\n\n[STATE]\nlocation: ' + 'tower '.repeat(20),
                },
            ],
        ];
        const settings = {
            memoryTokenBudget: 200,
            injectionTemplate: 'WRAP\n{{summary}}\nEND',
        };
        installSillyTavernStub({
            metadata: { summaryception: makeSummaryStore({ layers }) },
            settings,
            getTokenCountAsync: async (text) => countTokens(text),
        });

        const usage = await getEffectiveMemoryUsage(layers, settings);
        const view = buildContextBudgetViewModel({
            budget: settings.memoryTokenBudget,
            verbatim: budgetPart('Live Chat', 'verbatim', 0),
            layers: usage.parts,
        });
        const rawSnippetTokens = countTokens(layers[0].map((snippet) => snippet.text).join(' '));

        expect(view.used).toBe(usage.total.count);
        expect(view.used).toBeLessThan(rawSnippetTokens);
        expect(view.segments.map((segment) => segment.label)).toEqual([
            'State',
            'Layer 0',
            'Wrapper',
            'Free Space',
        ]);
    });
});

describe('trigger gauge model', () => {
    const plan = (summaryStats, overflowCount) => ({ rawPlan: { summaryStats, overflowCount } });

    it('binds the token gate when queued turns are light', () => {
        const model = buildTriggerGaugeModel(plan({ finalTokens: 4000 }, 3), {
            minSummaryBudget: 16000,
            minSummaryTurns: 3,
            maxSummaryTurns: 8,
        });

        expect(model.queuedTokens).toBe(4000);
        expect(model.triggerTokens).toBe(16000);
        expect(model.label).toBe('Trigger: tokens');
    });

    it('binds the turn gate when its token-equivalent exceeds the budget gate', () => {
        const model = buildTriggerGaugeModel(plan({ finalTokens: 12000 }, 2), {
            minSummaryBudget: 16000,
            minSummaryTurns: 6,
            maxSummaryTurns: 8,
        });

        // avg 6000/turn * 6 turns = 36000 > 16000 budget gate
        expect(model.triggerTokens).toBe(36000);
        expect(model.label).toBe('Trigger: 6 turns');
    });

    it('falls back to the token gate with no queued turns', () => {
        const model = buildTriggerGaugeModel(plan({ finalTokens: 0 }, 0), {
            minSummaryBudget: 16000,
            minSummaryTurns: 3,
            maxSummaryTurns: 8,
        });

        expect(model.queuedTokens).toBe(0);
        expect(model.triggerTokens).toBe(16000);
        expect(model.label).toBe('Trigger: tokens');
    });

    it('reads cache-mode flush stats when summary stats are absent', () => {
        const model = buildTriggerGaugeModel(
            {
                rawPlan: {
                    flushStats: { finalTokens: 5000, finalTokensEstimated: true },
                    overflowCount: 4,
                },
            },
            { minSummaryBudget: 16000, minSummaryTurns: 3, maxSummaryTurns: 8 },
        );

        expect(model.queuedTokens).toBe(5000);
        expect(model.queuedEstimated).toBe(true);
    });
});

function budgetPart(label, kind, count, estimated = false) {
    return { label, kind, count, estimated };
}

function segmentSummary(segment) {
    return [segment.label, segment.kind, segment.count];
}
