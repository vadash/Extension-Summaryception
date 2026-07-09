import { getChat } from '../foundation/context.js';
import {
    bumpSummaryStoreMutationEpoch,
    calculateContiguousSummarizedUpTo,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { buildPassageFromRangeWithStats } from '../core/chatutils.js';
import { unghostMessagesInRange } from '../core/ghosting.js';
import { validateSummarizerOutputIntegrity } from '../core/prompts.js';
import { callSummarizer, getIsSummarizing, setSummarizing } from '../core/summarizer.js';
import { withUsageRun } from '../core/summarizer-usage.js';
import { updateInjection } from './injection.js';

/**
 * @typedef {{ status: 'ready', range: [number, number], snippet: SummaryceptionSnippet, context: string }} RegenerationTarget
 * @typedef {{ status: 'missing' } | { status: 'unsupported' }} RegenerationUnavailable
 * @typedef {{ status: 'regenerated', range: [number, number] } | { status: 'empty-source' } | { status: 'failed' }} RegenerationRunResult
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
 * Get the source turn range that can be regenerated.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {{ status: 'ready', range: [number, number] } | { status: 'missing' | 'unsupported' | 'busy' }}
 */
export function getSnippetRegenerationTarget(layerIndex, snippetIndex) {
    const snippet = getSnippetAt(getChatStore(), layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing' };
    }

    const range = getSnippetTurnRange(snippet);
    if (layerIndex !== 0 || !range) {
        return { status: 'unsupported' };
    }
    if (getIsSummarizing()) {
        return { status: 'busy' };
    }

    return { status: 'ready', range };
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
    bumpSummaryStoreMutationEpoch(store);
    await saveSnippetStore();
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
        store.summarizedUpTo = calculateContiguousSummarizedUpTo(store);
        const range = getSnippetTurnRange(removed);
        if (range) {
            await unghostMessagesInRange(range[0], range[1]);
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
    const store = getChatStore();
    const target = getRegenerationTarget(store, layerIndex, snippetIndex);
    if (target.status !== 'ready') {
        return target;
    }
    if (getIsSummarizing()) {
        return { status: 'busy' };
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
    const [rangeStart, rangeEnd] = target.range;
    const passage = await buildPassageFromRangeWithStats(getChat(), rangeStart, rangeEnd);
    if (!passage.text.trim()) {
        return { status: 'empty-source' };
    }

    const newSummary = await callSummarizer(passage.text, target.context, {
        kind: 'regenerate',
        sourceRange: target.range,
        regexStats: passage.stats,
    });

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
    bumpSummaryStoreMutationEpoch(getChatStore());

    await saveSnippetStore();
    return { status: 'regenerated', range: target.range };
}

/**
 * Resolve a snippet into a regeneration target.
 * @param {SummaryceptionStore} store
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {RegenerationTarget | RegenerationUnavailable}
 */
function getRegenerationTarget(store, layerIndex, snippetIndex) {
    const snippet = getSnippetAt(store, layerIndex, snippetIndex);
    if (!snippet) {
        return { status: 'missing' };
    }

    const range = getSnippetTurnRange(snippet);
    if (layerIndex !== 0 || !range) {
        return { status: 'unsupported' };
    }

    return {
        status: 'ready',
        range,
        snippet,
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
    updateInjection();
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

/**
 * Get a valid turn range from a snippet.
 * @param {object} snippet
 * @returns {[number, number] | null}
 */
function getSnippetTurnRange(snippet) {
    const range = snippet?.turnRange;
    if (!Array.isArray(range) || range.length < 2) {
        return null;
    }
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
        return null;
    }
    return range[0] >= 0 && range[1] >= range[0] ? /** @type {[number, number]} */ (range) : null;
}
