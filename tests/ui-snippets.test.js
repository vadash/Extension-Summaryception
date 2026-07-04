import { describe, expect, it } from 'vitest';
import { buildSnippetBrowserViewModel, getSnippetBrowserRowKey } from '../src/entry/ui.js';

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
