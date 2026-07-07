import { INTERNAL_MAX_LAYER_DEPTH } from '../foundation/constants.js';
import { getContext } from '../foundation/context.js';
import {
    bumpSummaryStoreMutationEpoch,
    getSettings,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { debug, warn } from '../foundation/logger.js';
import { buildFullContext } from './chatutils.js';
import { getEffectiveMemoryUsage } from './memory-budget.js';
import { mergeStates, parseSnippet, serializeState } from './summarizer-state.js';
import { callSummarizer } from './summarizer-request.js';
import {
    commitWhenSafe,
    isPromptMutationFrozen,
    updateCommittedInjection,
} from './summarizer-commit.js';
import {
    getChatIdentity,
    getSummaryStoreSnapshotEpoch,
    isSameChatSnapshot,
} from './summarizer-snapshot.js';
import { countTextTokens, formatTokenValue } from './token-count.js';

const MIN_PROMOTION_MERGE_COUNT = 3;
const MAX_PROMOTION_MERGE_COUNT = 4;
const LAYER0_INITIAL_BUDGET_RATIO = 0.6;
const LAYER0_DEEP_BUDGET_RATIO = 0.5;
const LAYER1_BUDGET_RATIO = 0.3;
const DEEP_LAYER_BUDGET_RATIO = 0.2;

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
        debug(`Internal layer depth cap (${INTERNAL_MAX_LAYER_DEPTH}) reached.`);
        return false;
    }

    return await mergeLayerSnippets({
        layerIndex: candidate.layerIndex,
        s,
        quota: candidate.quota,
        layerTokens: candidate.tokens,
        layerCount: candidate.count,
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
 * @returns {Promise<Array<{ layerIndex: number, quota: number, tokens: number, count: number, totalTokens: number, tokenBudgetExceeded: boolean }>>}
 */
export async function getLayerMemoryQuotas(store, settings) {
    const active = getActiveLayers(store);
    if (active.length === 0) {
        return [];
    }

    const usage = await getEffectiveMemoryUsage(store.layers, settings);
    const layerTokens = getTokenCountsByLayer(usage);
    const hasDeepLayers = active.some((layer) => layer.layerIndex >= 2);
    const deepLayerTokens = getDeepLayerTokenCount(active, layerTokens);
    const budget = Math.max(1, Number(settings.memoryTokenBudget) || 1);
    const quotas = [];
    for (const layer of active) {
        const quota = getLayerQuota(layer.layerIndex, budget, hasDeepLayers);
        quotas.push({
            layerIndex: layer.layerIndex,
            quota,
            tokens:
                layer.layerIndex >= 2 ? deepLayerTokens : layerTokens.get(layer.layerIndex) || 0,
            count: layer.snippets.length,
            totalTokens: usage.total.count,
            tokenBudgetExceeded: usage.total.count > budget,
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
        active.push({ layerIndex: i, snippets });
    }
    return active;
}

function getTokenCountsByLayer(usage) {
    const tokens = new Map();
    for (const part of usage.layers) {
        tokens.set(part.layerIndex, part.count);
    }
    if (usage.state) {
        tokens.set(0, (tokens.get(0) || 0) + usage.state.count);
    }
    return tokens;
}

function getDeepLayerTokenCount(active, tokens) {
    return active.reduce((sum, layer) => {
        if (layer.layerIndex < 2) {
            return sum;
        }
        return sum + (tokens.get(layer.layerIndex) || 0);
    }, 0);
}

function getLayerQuota(layerIndex, budget, hasDeepLayers) {
    if (layerIndex === 0) {
        return Math.max(
            1,
            Math.floor(
                budget * (hasDeepLayers ? LAYER0_DEEP_BUDGET_RATIO : LAYER0_INITIAL_BUDGET_RATIO),
            ),
        );
    }
    if (layerIndex === 1) {
        return Math.max(1, Math.floor(budget * LAYER1_BUDGET_RATIO));
    }
    return Math.max(1, Math.floor(budget * DEEP_LAYER_BUDGET_RATIO));
}

function isLayerOverLimit(quota, settings) {
    if (quota.count < getEffectivePromotionBatchSize(settings)) {
        return false;
    }
    if (quota.count > settings.snippetsPerLayer) {
        return true;
    }
    return quota.tokens > quota.quota;
}

function canPromoteLayer(layerIndex) {
    return layerIndex < INTERNAL_MAX_LAYER_DEPTH - 1;
}

function getEffectivePromotionBatchSize(settings) {
    const configured = Number(settings.snippetsPerPromotion);
    if (!Number.isFinite(configured)) {
        return MIN_PROMOTION_MERGE_COUNT;
    }
    return Math.min(
        MAX_PROMOTION_MERGE_COUNT,
        Math.max(MIN_PROMOTION_MERGE_COUNT, Math.round(configured)),
    );
}

/**
 * Merge snippets into the next layer using the summarizer.
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {ExtensionSettings} p.s
 * @param {number} p.quota
 * @param {number} p.layerTokens
 * @param {number} p.layerCount
 * @returns {Promise<boolean>}
 */
async function mergeLayerSnippets({ layerIndex, s, quota, layerTokens, layerCount }) {
    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const mergeCount = getEffectivePromotionBatchSize(s);
    const toMerge = layer.slice(0, mergeCount);
    if (toMerge.length < mergeCount) {
        return false;
    }

    const sourceMemoryText = toMerge.map((sn) => sn.text).join(' ');
    const parsed = toMerge.map((sn) => parseSnippet(sn.text));
    const storyTxt = parsed
        .map((snippet) => snippet.narrative.trim())
        .filter(Boolean)
        .join('\n\n');
    const mergedState = mergeStates(parsed.map((snippet) => snippet.state));
    const serializedState = serializeState(mergedState);
    const sourceState = serializedState || '(none)';
    const memoryTokensBefore = await countTextTokens(sourceMemoryText);
    const contextStr = buildFullContext(layerIndex + 1);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt: sourceMemoryText,
        contextStr,
    };

    toastr.info(
        `Promoting ${toMerge.length} memories: Layer ${layerIndex} -> Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    if (!storyTxt) {
        return false;
    }
    const metaNarrative = await callSummarizer(storyTxt, contextStr, {
        kind: 'promotion',
        layerIndex,
        mergedSnippetCount: toMerge.length,
        memoryTokensBefore: memoryTokensBefore.count,
        memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
        overflowLayerIndex: layerIndex,
        overflowMemoryCount: layerCount,
        overflowMemoryLimit: s.snippetsPerLayer,
        overflowTokens: layerTokens,
        overflowTokenQuota: quota,
        sourceState,
    });
    if (!metaNarrative) {
        return false;
    }
    const metaSummary = combinePromotedMemory(metaNarrative);
    if (!metaSummary) {
        return false;
    }
    if (
        !(await isPromotionCompressed({
            layerIndex,
            mergeCount,
            metaSummary,
            settings: s,
            sourceMemoryText,
        }))
    ) {
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

function combinePromotedMemory(narrative) {
    const parsed = parseSnippet(narrative);
    return parsed.narrative.trim();
}

async function isPromotionCompressed({
    layerIndex,
    mergeCount,
    metaSummary,
    settings,
    sourceMemoryText,
}) {
    const sourceTokens = await countTextTokens(sourceMemoryText);
    const outputTokens = await countTextTokens(metaSummary);
    if (outputTokens.count >= sourceTokens.count) {
        warn(
            `Promotion L${layerIndex} rejected: output did not compress source ` +
                `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens).`,
        );
        return false;
    }

    const store = getChatStore();
    const memoryTokensBefore = await getEffectiveMemoryUsage(store.layers, settings);
    const nextLayers = buildHypotheticalPromotionLayers(
        store.layers,
        layerIndex,
        mergeCount,
        metaSummary,
    );
    const memoryTokensAfter = await getEffectiveMemoryUsage(nextLayers, settings);
    if (memoryTokensAfter.total.count < memoryTokensBefore.total.count) {
        return true;
    }

    warn(
        `Promotion L${layerIndex} rejected: memory did not compress ` +
            `(${formatTokenValue(
                memoryTokensBefore.total.count,
                memoryTokensBefore.total.estimated,
            )}->` +
            `${formatTokenValue(
                memoryTokensAfter.total.count,
                memoryTokensAfter.total.estimated,
            )} tokens).`,
    );
    return false;
}

function buildHypotheticalPromotionLayers(layers, layerIndex, mergeCount, metaSummary) {
    const sourceLayers = Array.isArray(layers) ? layers : [];
    const nextLayers = sourceLayers.map((layer) => (Array.isArray(layer) ? [...layer] : layer));
    const sourceLayer = Array.isArray(nextLayers[layerIndex]) ? [...nextLayers[layerIndex]] : [];
    const destLayer = Array.isArray(nextLayers[layerIndex + 1])
        ? [...nextLayers[layerIndex + 1]]
        : [];

    sourceLayer.splice(0, mergeCount);
    destLayer.push({ text: metaSummary });
    nextLayers[layerIndex] = sourceLayer;
    nextLayers[layerIndex + 1] = destLayer;
    return nextLayers;
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
        summaryStoreEpoch: getSummaryStoreSnapshotEpoch(store),
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
    bumpSummaryStoreMutationEpoch(store);

    await savePromotionCommit();

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
    return getSummaryStoreSnapshotEpoch(store) === snapshot.summaryStoreEpoch;
}

/**
 * Persist a promotion and refresh injection when the foreground guard permits it.
 * @returns {Promise<void>}
 */
async function savePromotionCommit() {
    await saveChatStore();
    await updateCommittedInjection({ logMemoryStatus: true });
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
