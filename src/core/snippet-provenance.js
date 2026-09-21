import { resolveScIdsToIndices } from '../foundation/message-identity.js';

/**
 * The Snippet provenance read models (CONTEXT.md): which stable message
 * identifiers the committed Snippets own, and how far into the chat that
 * ownership currently reaches.
 */

/**
 * Deduplicates across layers, keeping first-seen order. Ids are compared
 * and kept raw (never trimmed); non-string and blank ids are skipped.
 * @param {Array<Array<SummaryceptionSnippet>> | null | undefined} layers
 * @param {{ layerIndex?: number }} [options] - Read only this layer when given.
 * @returns {string[]}
 */
export function collectSnippetSourceIds(layers, { layerIndex } = {}) {
    const sources = layerIndex === undefined ? layers || [] : [layers?.[layerIndex] || []];
    const ids = [];
    const seen = new Set();
    for (const layer of sources) {
        for (const snippet of layer || []) {
            for (const id of snippet?.sourceMessageIds || []) {
                if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) {
                    continue;
                }
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}

/**
 * Resolve the highest current chat index owned by a Layer 0 snippet.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getCurrentSummarizedBoundary(chat, store) {
    const sourceMessageIds = collectSnippetSourceIds(store?.layers, { layerIndex: 0 });
    const indices = resolveScIdsToIndices(chat, sourceMessageIds);
    return indices.length > 0 ? indices[indices.length - 1] : -1;
}
