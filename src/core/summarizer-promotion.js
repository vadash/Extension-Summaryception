import { INTERNAL_MAX_LAYER_DEPTH } from '../foundation/constants.js';
import { getContext } from '../foundation/context.js';
import { getSettings, getChatStore, saveChatStore } from '../foundation/state.js';
import { log } from '../foundation/logger.js';
import { buildFullContext } from './chatutils.js';
import { callSummarizer } from './summarizer-request.js';
import {
    commitWhenSafe,
    isPromptMutationFrozen,
    updateCommittedInjection,
} from './summarizer-commit.js';
import {
    fingerprintSummaryStore,
    getChatIdentity,
    isSameChatSnapshot,
} from './summarizer-snapshot.js';
import { countTextTokens } from './token-count.js';

/**
 * Promote the shallowest over-limit layer at or after the requested layer.
 * @param {number} layerIndex - First layer to evaluate
 * @returns {Promise<boolean>} True when promotion work applied or queued.
 */
export async function maybePromoteLayer(layerIndex = 0) {
    const s = getSettings();
    const candidate = await getNextPromotionCandidate(layerIndex, s);
    if (!candidate) {
        return false;
    }

    if (!canPromoteLayer(candidate.layerIndex)) {
        log(`Internal layer depth cap (${INTERNAL_MAX_LAYER_DEPTH}) reached.`);
        return false;
    }

    return await mergeLayerSnippets({
        layerIndex: candidate.layerIndex,
        s,
        quota: candidate.quota,
    });
}

/**
 * Check whether any promotable layer exceeds its dynamic quota or memory count.
 * @param {number} startLayer
 * @returns {Promise<boolean>}
 */
export async function hasPromotionOverflow(startLayer = 0) {
    return Boolean(await getNextPromotionCandidate(startLayer, getSettings()));
}

/**
 * Build normalized token quotas for active non-empty layers.
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<Array<{ layerIndex: number, quota: number, tokens: number, count: number }>>}
 */
export async function getLayerMemoryQuotas(store, settings) {
    const active = getActiveLayers(store);
    if (active.length === 0) {
        return [];
    }

    const totalWeight = active.reduce((sum, layer) => sum + layer.weight, 0);
    const budget = Math.max(1, Number(settings.memoryTokenBudget) || 1);
    const quotas = [];
    for (const layer of active) {
        const quota = Math.max(1, Math.floor((budget * layer.weight) / totalWeight));
        quotas.push({
            layerIndex: layer.layerIndex,
            quota,
            tokens: await countLayerTokens(layer.snippets),
            count: layer.snippets.length,
        });
    }
    return quotas;
}

async function getNextPromotionCandidate(startLayer, settings) {
    const store = getChatStore();
    const quotas = await getLayerMemoryQuotas(store, settings);
    for (const quota of quotas) {
        if (quota.layerIndex < startLayer) {
            continue;
        }
        if (isLayerOverLimit(quota, settings)) {
            return quota;
        }
    }
    return null;
}

function getActiveLayers(store) {
    const layers = Array.isArray(store.layers) ? store.layers : [];
    const active = [];
    for (let i = 0; i < layers.length; i++) {
        const snippets = layers[i];
        if (!Array.isArray(snippets) || snippets.length === 0) {
            continue;
        }
        active.push({ layerIndex: i, snippets, weight: 1 / 2 ** i });
    }
    return active;
}

async function countLayerTokens(snippets) {
    const text = snippets.map((snippet) => snippet.text).join(' ');
    return (await countTextTokens(text)).count;
}

function isLayerOverLimit(quota, settings) {
    return quota.tokens > quota.quota || quota.count > settings.snippetsPerLayer;
}

function canPromoteLayer(layerIndex) {
    return layerIndex < INTERNAL_MAX_LAYER_DEPTH - 1;
}

/**
 * Merge snippets into the next layer using the summarizer.
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {ExtensionSettings} p.s
 * @param {number} p.quota
 * @returns {Promise<boolean>}
 */
async function mergeLayerSnippets({ layerIndex, s, quota }) {
    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const toMerge = layer.slice(0, Math.max(1, s.snippetsPerPromotion));
    if (toMerge.length === 0) {
        return false;
    }

    log(
        `Layer ${layerIndex}: ${layer.length} memories exceed quota ` +
            `${quota} tokens or count ${s.snippetsPerLayer}; promoting`,
    );

    const storyTxt = toMerge.map((sn) => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt,
        contextStr,
    };

    toastr.info(
        `Promoting ${toMerge.length} memories: Layer ${layerIndex} -> Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr, {
        kind: 'promotion',
        layerIndex,
        mergedSnippetCount: toMerge.length,
    });
    if (!metaSummary) {
        return false;
    }

    const result = await commitWhenSafe({
        kind: 'promotion-merge',
        snapshot,
        apply: async () => applyMergePromotion({ snapshot, layerIndex, metaSummary }),
    });

    if (result === 'applied') {
        await promoteOverflowLayers();
    }
    return result !== 'stale';
}

/**
 * Capture summary-store state for a promotion transaction.
 * @param {number} layerIndex
 * @returns {object}
 */
function capturePromotionSnapshot(layerIndex) {
    const ctx = getContext();
    const store = getChatStore();

    return {
        chatId: getChatIdentity(ctx),
        chatRef: ctx.chat,
        layerIndex,
        summaryStoreFingerprint: fingerprintSummaryStore(store),
    };
}

/**
 * Apply an LLM-backed merge promotion after validating the source layers.
 * @param {object} p
 * @param {object} p.snapshot
 * @param {number} p.layerIndex
 * @param {string} p.metaSummary
 * @returns {Promise<boolean>}
 */
async function applyMergePromotion({ snapshot, layerIndex, metaSummary }) {
    if (!isPromotionSnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const destLayer = store.layers[layerIndex + 1] || [];
    const toMerge = layer.splice(0, snapshot.mergeCount);

    if (toMerge.length !== snapshot.mergeCount) {
        return false;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });
    store.layers[layerIndex + 1] = destLayer;

    await savePromotionCommit();
    log(`Layer ${layerIndex + 1} now has ${destLayer.length} memories`);

    return true;
}

/**
 * Revalidate that summary layers were not changed during a promotion request.
 * @param {object} snapshot
 * @returns {boolean}
 */
function isPromotionSnapshotValid(snapshot) {
    const ctx = getContext();
    const store = getChatStore();

    if (!isSameChatSnapshot(snapshot, ctx)) {
        return false;
    }
    return fingerprintSummaryStore(store) === snapshot.summaryStoreFingerprint;
}

/**
 * Persist a promotion and refresh injection when the foreground guard permits it.
 * @returns {Promise<void>}
 */
async function savePromotionCommit() {
    await saveChatStore();
    await updateCommittedInjection();
}

/**
 * Continue promotion while any shallow layer remains over its limit.
 * @returns {Promise<void>}
 */
async function promoteOverflowLayers() {
    if (isPromptMutationFrozen()) {
        return;
    }

    const promoted = await maybePromoteLayer(0);
    if (promoted && !isPromptMutationFrozen()) {
        await promoteOverflowLayers();
    }
}
