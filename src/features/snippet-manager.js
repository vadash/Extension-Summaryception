import { getChat } from '../foundation/context.js';
import { rangesFromSortedIndices, resolveScIdsToIndices } from '../foundation/message-identity.js';
import { bumpSummaryStoreMutationEpoch, getChatStore, saveChatStore } from '../foundation/state.js';
import { buildPassageFromRangeWithStats } from '../core/chatutils.js';
import { unghostMessagesInRange } from '../core/ghosting.js';
import { validateSummarizerOutputIntegrity } from '../core/prompts.js';
import { buildSnippetMetadataFromState } from '../core/snippet-metadata.js';
import { parseSnippet } from '../core/summarizer-state.js';
import { callSummarizer, getIsSummarizing, setSummarizing } from '../core/summarizer.js';
import { withUsageRun } from '../core/summarizer-usage.js';
import { refreshExtensionState } from './persist.js';

/**
 * @typedef {{ status: 'ready', snippet: SummaryceptionSnippet, range: [number, number], context: string }} RegenerationTarget
 * @typedef {{ status: 'missing' } | { status: 'unsupported' } | { status: 'busy' }} RegenerationUnavailable
 * @typedef {{ status: 'regenerated', range: [number, number] } | { status: 'empty-source' } | { status: 'unsupported' } | { status: 'failed' }} RegenerationRunResult
 * @typedef {{ status: 'regenerated', range: [number, number] } | { status: 'missing' | 'unsupported' | 'busy' | 'empty-source' | 'failed' }} RegenerateSnippetResult
 */

/**
 * Get snippet text for an entry-layer editor.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {{ status: 'found', text: string } | { status: 'missing', text: '' }}
 */
export function getSnippetTextAt(layerIndex, snippetIndex) {
    const snippet = getSnippetAt(getChatStore(), layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing', text: '' };
    }
    return { status: 'found', text: snippet.text };
}

/**
 * Get the regeneration target for a snippet as seen by the UI.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {RegenerationTarget | RegenerationUnavailable}
 */
export function getSnippetRegenerationTarget(layerIndex, snippetIndex) {
    return resolveRegenerationTarget(getChatStore(), getChat(), layerIndex, snippetIndex);
}

/**
 * Persist an edited snippet.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @param {string} text
 * @returns {Promise<{ status: 'updated' | 'missing' | 'empty' | 'unchanged' }>}
 */
export async function updateSnippetTextAt(layerIndex, snippetIndex, text) {
    const store = getChatStore();
    const snippet = getSnippetAt(store, layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing' };
    }

    const newText = String(text).trim();
    if (!newText) {
        return { status: 'empty' };
    }
    if (newText === snippet.text) {
        return { status: 'unchanged' };
    }

    snippet.text = newText;
    if (layerIndex === 0) {
        Object.assign(snippet, buildSnippetMetadataFromState(parseSnippet(newText).state));
    }
    bumpSummaryStoreMutationEpoch(store);
    return { status: 'updated' };
}

/**
 * Delete one snippet and repair any Layer 0 ghosting ownership.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {Promise<{ status: 'deleted', layerIndex: number } | { status: 'missing' }>}
 */
export async function deleteSnippetAt(layerIndex, snippetIndex) {
    const store = getChatStore();
    const layer = store.layers[layerIndex];
    if (!layer || !layer[snippetIndex]) {
        return { status: 'missing' };
    }

    const removed = layer[snippetIndex];
    layer.splice(snippetIndex, 1);
    bumpSummaryStoreMutationEpoch(store);

    if (layerIndex === 0) {
        const remainingIds = new Set(
            store.layers.flatMap((snippets) =>
                snippets.flatMap((snippet) => snippet.sourceMessageIds || []),
            ),
        );
        const removedIds = new Set(removed.sourceMessageIds.filter((id) => !remainingIds.has(id)));
        store.ghostedMessageIds = store.ghostedMessageIds.filter((id) => !removedIds.has(id));
        const indices = resolveScIdsToIndices(getChat(), [...removedIds]);
        for (const [start, end] of rangesFromSortedIndices(indices)) {
            await unghostMessagesInRange(start, end);
        }
    }

    await saveSnippetStore();
    return { status: 'deleted', layerIndex };
}

/**
 * Regenerate one Layer 0 snippet from its source turns.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {Promise<RegenerateSnippetResult>}
 */
export async function regenerateSnippetAt(layerIndex, snippetIndex) {
    const target = resolveRegenerationTarget(getChatStore(), getChat(), layerIndex, snippetIndex);
    if (target.status !== 'ready') {
        return target;
    }

    setSummarizing(true);
    try {
        return await withUsageRun('snippet regeneration', async () => {
            return await regenerateSnippetWithTarget(target);
        });
    } finally {
        setSummarizing(false);
    }
}

/**
 * Run the summarizer for a validated regeneration target.
 * @param {RegenerationTarget} target
 * @returns {Promise<RegenerationRunResult>}
 */
async function regenerateSnippetWithTarget(target) {
    const chat = getChat();
    const [rangeStart, rangeEnd] = target.range;
    const passage = await buildPassageFromRangeWithStats(chat, rangeStart, rangeEnd);
    if (!passage.text.trim()) {
        return { status: 'empty-source' };
    }

    const outcome = await callSummarizer(passage.text, target.context, {
        kind: 'regenerate',
        sourceRange: target.range,
        regexStats: passage.stats,
    });

    const newSummary = outcome.status === 'completed' ? outcome.text : '';
    if (!newSummary) {
        return { status: 'failed' };
    }
    const integrityResult = validateSummarizerOutputIntegrity(newSummary, {
        kind: 'regenerate',
        sourceRange: target.range,
        regexStats: passage.stats,
    });
    if (!integrityResult.valid) {
        return { status: 'failed' };
    }

    target.snippet.text = newSummary;
    target.snippet.timestamp = Date.now();
    target.snippet.regenerated = true;
    Object.assign(target.snippet, buildSnippetMetadataFromState(parseSnippet(newSummary).state));
    bumpSummaryStoreMutationEpoch(getChatStore());

    await saveSnippetStore();
    return { status: 'regenerated', range: target.range };
}

/**
 * Resolve a snippet into a regeneration target: the single source of truth
 * shared by the UI check and the regeneration runner. A target is ready only
 * for a contiguous Layer 0 source range while no summarization is running.
 * @param {SummaryceptionStore} store
 * @param {ChatMessage[]} chat
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {RegenerationTarget | RegenerationUnavailable}
 */
function resolveRegenerationTarget(store, chat, layerIndex, snippetIndex) {
    const snippet = getSnippetAt(store, layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing' };
    }
    const indices = Array.isArray(snippet.sourceMessageIds)
        ? resolveScIdsToIndices(chat, snippet.sourceMessageIds)
        : [];
    if (
        layerIndex !== 0 ||
        indices.length === 0 ||
        indices[indices.length - 1] - indices[0] + 1 !== indices.length
    ) {
        return { status: 'unsupported' };
    }
    if (getIsSummarizing()) {
        return { status: 'busy' };
    }

    return {
        status: 'ready',
        snippet,
        range: /** @type {[number, number]} */ ([indices[0], indices[indices.length - 1]]),
        context: buildSnippetContext(store, layerIndex, snippetIndex),
    };
}

function getSnippetAt(store, layerIndex, snippetIndex) {
    if (!Number.isInteger(layerIndex) || !Number.isInteger(snippetIndex)) {
        return null;
    }
    return store.layers[layerIndex]?.[snippetIndex] || null;
}

async function saveSnippetStore() {
    await saveChatStore();
    refreshExtensionState({ injection: true, ui: false });
}

function buildSnippetContext(store, excludeLayerIndex, excludeSnippetIndex) {
    const contextParts = [];
    for (let i = store.layers.length - 1; i >= 0; i--) {
        const layer = store.layers[i];
        if (!layer) {
            continue;
        }
        collectLayerContext({
            contextParts,
            layer,
            layerIndex: i,
            excludeLayerIndex,
            excludeSnippetIndex,
        });
    }
    return contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';
}

function collectLayerContext({
    contextParts,
    layer,
    layerIndex,
    excludeLayerIndex,
    excludeSnippetIndex,
}) {
    for (let i = 0; i < layer.length; i++) {
        if (layerIndex === excludeLayerIndex && i === excludeSnippetIndex) {
            continue;
        }
        contextParts.push(layer[i].text);
    }
}
