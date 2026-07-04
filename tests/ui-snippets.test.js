import { describe, expect, it } from 'vitest';
import {
    buildContextBudgetViewModel,
    buildSnippetBrowserViewModel,
    formatBudgetTokenLabel,
    getSnippetBrowserRowKey,
} from '../src/entry/ui.js';

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
        expect(view.totalLabel).toBe('8000 / 16000');
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

    it('preserves estimated token labels', () => {
        const view = buildContextBudgetViewModel({
            budget: 10000,
            verbatim: budgetPart('Verbatim Window', 'verbatim', 1000, true),
            layers: [],
        });

        expect(formatBudgetTokenLabel(1000, true)).toBe('~1000');
        expect(view.totalLabel).toBe('~1000 / 10000');
        expect(view.segments[0].estimated).toBe(true);
    });
});

function budgetPart(label, kind, count, estimated = false) {
    return { label, kind, count, estimated };
}

function segmentSummary(segment) {
    return [segment.label, segment.kind, segment.count];
}
