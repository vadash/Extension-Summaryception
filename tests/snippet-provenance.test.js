import { describe, expect, it } from 'vitest';

import {
    collectSnippetSourceIds,
    getCurrentSummarizedBoundary,
} from '../src/core/snippet-provenance.js';
import { makeMessages, makeSummaryStore } from './test-helpers.js';

/**
 * The Snippet provenance read models: which stable message identifiers the
 * committed Snippets own, and how far into the chat that ownership reaches.
 * Both read models are pure — the store and the chat are the whole fixture.
 */
describe('collectSnippetSourceIds', () => {
    it('flattens provenance across all layers, deduping in first-seen order', () => {
        const layers = [
            [
                { text: 'a', sourceMessageIds: ['m-2', 'm-1'] },
                { text: 'b', sourceMessageIds: ['m-1', 'm-3'] },
            ],
            [{ text: 'c', sourceMessageIds: ['m-3', 'm-4'] }],
            [],
        ];
        expect(collectSnippetSourceIds(layers)).toEqual(['m-2', 'm-1', 'm-3', 'm-4']);
    });

    it('skips non-string and blank ids and dedupes on the raw value', () => {
        const layers = [[{ text: 'a', sourceMessageIds: ['', '   ', 7, null, ' m-1 ', ' m-1 '] }]];
        expect(collectSnippetSourceIds(layers)).toEqual([' m-1 ']);
    });

    it('reads only the requested layer when layerIndex is given', () => {
        const layers = [
            [{ text: 'a', sourceMessageIds: ['m-1'] }],
            [{ text: 'b', sourceMessageIds: ['m-2', 'm-1'] }],
        ];
        expect(collectSnippetSourceIds(layers, { layerIndex: 0 })).toEqual(['m-1']);
        expect(collectSnippetSourceIds(layers, { layerIndex: 1 })).toEqual(['m-2', 'm-1']);
    });

    it('tolerates missing layers and snippets without provenance', () => {
        expect(collectSnippetSourceIds(undefined)).toEqual([]);
        expect(collectSnippetSourceIds([[{ text: 'no ids' }], null], { layerIndex: 1 })).toEqual(
            [],
        );
    });
});

describe('getCurrentSummarizedBoundary', () => {
    it('returns -1 when no Layer 0 source ID resolves', () => {
        expect(getCurrentSummarizedBoundary(makeMessages(2), makeSummaryStore())).toBe(-1);
    });

    it('tracks surviving source IDs after a live message deletion shifts indices', () => {
        const chat = makeMessages(5);
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['message-1', 'message-4'] }]],
        });

        expect(getCurrentSummarizedBoundary(chat, store)).toBe(4);
        chat.splice(2, 1);
        expect(getCurrentSummarizedBoundary(chat, store)).toBe(3);
    });
});
