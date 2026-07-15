import { INTERNAL_MAX_LAYER_DEPTH } from '../foundation/constants.js';
import { getContext } from '../foundation/context.js';
import {
    bumpSummaryStoreMutationEpoch,
    getEffectiveSettings,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { debug, warn } from '../foundation/logger.js';
import { buildFullContext } from './chatutils.js';
import { getEffectiveMemoryUsage } from './memory-budget.js';
import {
    buildPromotedSnippetMetadata,
    formatAnchoredSnippetNarrative,
    formatSnippetAnchor,
    stripLeadingSnippetAnchor,
} from './snippet-metadata.js';
import {
    compileGlobalState,
    isSnapshotStateSnippet,
    mergeStates,
    parseSnippet,
    serializeState,
} from './summarizer-state.js';
import { callSummarizer } from './summarizer-request.js';
import { validateSummarizerOutputIntegrity } from './prompts.js';
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
const LAYER0_PROMOTION_RETENTION_FLOOR_RATIO = 0.4;
const MIN_PROMOTION_COMPRESSION_SAVINGS = 0.25;

/**
 * Promote the shallowest over-limit layer at or after the requested layer.
 * @param {number} layerIndex - First layer to evaluate
 * @returns {Promise<boolean>} True when promotion work applied or queued.
 */
export async function maybePromoteLayer(layerIndex = 0) {
    const s = getEffectiveSettings();
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
    return Boolean(await getNextPromotionCandidate(startLayer, getEffectiveSettings()));
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
    const prepared = await prepareLayerPromotion({
        layerIndex,
        settings: s,
        quota,
        layerTokens,
        layerCount,
    });
    if (!prepared) {
        return false;
    }

    const promotedSnippet = await generateValidatedPromotion(prepared);
    if (!promotedSnippet) {
        return false;
    }

    return await commitValidatedPromotion({ prepared, promotedSnippet });
}

async function prepareLayerPromotion({ layerIndex, settings, quota, layerTokens, layerCount }) {
    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const mergeCount = getEffectivePromotionBatchSize(settings);
    const toMerge = layer.slice(0, mergeCount);
    if (toMerge.length < mergeCount) {
        return null;
    }

    if (
        await wouldViolateLayer0RetentionFloor({
            layerIndex,
            layers: store.layers,
            mergeCount,
            settings,
            quota,
        })
    ) {
        debug(
            `L0 promotion skipped: projected L0 memory would fall below ${Math.round(
                LAYER0_PROMOTION_RETENTION_FLOOR_RATIO * 100,
            )}% of quota.`,
        );
        return null;
    }

    const sourceMemoryText = toMerge.map((sn) => sn.text).join(' ');
    const parsed = toMerge.map((sn) => parseSnippet(sn.text));
    const storyTxt = toMerge
        .map((snippet) => formatAnchoredSnippetNarrative(snippet))
        .filter(Boolean)
        .join('\n\n');
    const mergedState = isSnapshotStateSnippet(toMerge[toMerge.length - 1])
        ? compileGlobalState([toMerge])
        : mergeStates(parsed.map((snippet) => snippet.state));
    const serializedState = serializeState(mergedState);
    const sourceState = serializedState || '(none)';
    const memoryTokensBefore = await countTextTokens(sourceMemoryText);
    const contextStr = buildFullContext(layerIndex + 1);
    const promotedMetadata = buildPromotedSnippetMetadata(toMerge);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt: sourceMemoryText,
        contextStr,
        promotedMetadata,
    };
    const promotionMetadata = {
        kind: 'promotion',
        layerIndex,
        mergedSnippetCount: toMerge.length,
        memoryTokensBefore: memoryTokensBefore.count,
        memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
        overflowLayerIndex: layerIndex,
        overflowMemoryCount: layerCount,
        overflowMemoryLimit: settings.snippetsPerLayer,
        overflowTokens: layerTokens,
        overflowTokenQuota: quota,
        sourceState,
    };

    return {
        layerIndex,
        mergeCount,
        settings,
        toMerge,
        sourceMemoryText,
        memoryTokensBefore,
        storyTxt,
        contextStr,
        promotedMetadata,
        snapshot,
        promotionMetadata,
    };
}

async function generateValidatedPromotion(prepared) {
    toastr.info(
        `Promoting ${prepared.toMerge.length} memories: Layer ${prepared.layerIndex} -> ` +
            `Layer ${prepared.layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    if (!prepared.storyTxt) {
        return null;
    }

    const metaNarrative = await callSummarizer(
        prepared.storyTxt,
        prepared.contextStr,
        prepared.promotionMetadata,
    );
    if (!metaNarrative) {
        return null;
    }

    return await buildValidatedPromotionSnippet({
        layerIndex: prepared.layerIndex,
        mergeCount: prepared.mergeCount,
        settings: prepared.settings,
        sourceMemoryText: prepared.sourceMemoryText,
        sourceTokens: prepared.memoryTokensBefore,
        storyTxt: prepared.storyTxt,
        contextStr: prepared.contextStr,
        metadata: prepared.promotionMetadata,
        narrative: metaNarrative,
        promotedMetadata: prepared.promotedMetadata,
    });
}

async function commitValidatedPromotion({ prepared, promotedSnippet }) {
    const result = await commitWhenSafe({
        kind: 'promotion-merge',
        snapshot: prepared.snapshot,
        apply: async () =>
            applyMergePromotion({
                snapshot: prepared.snapshot,
                layerIndex: prepared.layerIndex,
                promotedSnippet,
            }),
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

async function buildValidatedPromotionSnippet({
    layerIndex,
    mergeCount,
    settings,
    sourceMemoryText,
    sourceTokens,
    storyTxt,
    contextStr,
    metadata,
    narrative,
    promotedMetadata,
}) {
    const firstCandidate = buildPromotionCandidate(narrative, promotedMetadata);
    if (!firstCandidate) {
        return null;
    }

    const firstValidation = await validatePromotionCandidate({
        layerIndex,
        mergeCount,
        promotedSnippet: firstCandidate,
        settings,
        sourceMemoryText,
        sourceTokens,
    });
    if (firstValidation.valid) {
        return firstCandidate;
    }

    if (
        firstValidation.reason !== 'compression-ratio' ||
        !firstValidation.outputTokens ||
        !firstValidation.sourceTokens
    ) {
        return null;
    }

    const repairNarrative = await callSummarizer(storyTxt, contextStr, {
        ...metadata,
        promotionRepair: {
            outputTokens: firstValidation.outputTokens.count,
            requiredMaxTokens: firstValidation.requiredMaxTokens,
            sourceTokens: firstValidation.sourceTokens.count,
            rejectedSummary: firstCandidate.text,
        },
    });
    const repairedCandidate = buildPromotionCandidate(repairNarrative, promotedMetadata);
    if (!repairedCandidate) {
        return null;
    }

    const repairedValidation = await validatePromotionCandidate({
        layerIndex,
        mergeCount,
        promotedSnippet: repairedCandidate,
        settings,
        sourceMemoryText,
        sourceTokens,
    });
    return repairedValidation.valid ? repairedCandidate : null;
}

function buildPromotionCandidate(narrative, promotedMetadata) {
    const metaSummary = combinePromotedMemory(narrative);
    if (!metaSummary) {
        return null;
    }
    const cleanSummary = formatSnippetAnchor(promotedMetadata)
        ? stripLeadingSnippetAnchor(metaSummary)
        : metaSummary;
    if (!cleanSummary) {
        return null;
    }
    return buildPromotedSnippet(cleanSummary, promotedMetadata);
}

async function validatePromotionCandidate({
    layerIndex,
    mergeCount,
    promotedSnippet,
    settings,
    sourceMemoryText,
    sourceTokens: providedSourceTokens,
}) {
    const sourceTokens = providedSourceTokens || (await countTextTokens(sourceMemoryText));
    if (!isPromotionSummarySafe({ layerIndex, promotedSnippet, sourceTokens })) {
        return { valid: false, reason: 'integrity' };
    }

    const outputTokens = await countTextTokens(promotedSnippet.text);
    const requiredMaxTokens = getPromotionCompressionMaxTokens(sourceTokens.count);
    if (outputTokens.count > requiredMaxTokens) {
        warn(
            `Promotion L${layerIndex} rejected: output did not meet minimum compression ` +
                `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens; ` +
                `required <=${formatTokenValue(requiredMaxTokens, sourceTokens.estimated)}).`,
        );
        return {
            valid: false,
            reason: 'compression-ratio',
            sourceTokens,
            outputTokens,
            requiredMaxTokens,
        };
    }

    const store = getChatStore();
    const memoryTokensBefore = await getEffectiveMemoryUsage(store.layers, settings);
    const nextLayers = buildHypotheticalPromotionLayers(
        store.layers,
        layerIndex,
        mergeCount,
        promotedSnippet,
    );
    const memoryTokensAfter = await getEffectiveMemoryUsage(nextLayers, settings);
    if (memoryTokensAfter.total.count < memoryTokensBefore.total.count) {
        return { valid: true };
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
    return { valid: false, reason: 'memory-total' };
}

function getPromotionCompressionMaxTokens(sourceTokenCount) {
    const source = Math.max(0, Number(sourceTokenCount) || 0);
    return Math.floor(source * (1 - MIN_PROMOTION_COMPRESSION_SAVINGS));
}

function isPromotionSummarySafe({ layerIndex, promotedSnippet, sourceTokens }) {
    const integrityResult = validateSummarizerOutputIntegrity(promotedSnippet.text, {
        kind: 'promotion',
        memoryTokensBefore: sourceTokens.count,
        memoryTokensBeforeEstimated: sourceTokens.estimated,
    });
    if (integrityResult.valid) {
        return true;
    }

    warn(`Promotion L${layerIndex} rejected: ${integrityResult.error.message}.`);
    return false;
}

function buildHypotheticalPromotionLayers(layers, layerIndex, mergeCount, promotedSnippet) {
    const sourceLayers = Array.isArray(layers) ? layers : [];
    const nextLayers = sourceLayers.map((layer) =>
        Array.isArray(layer) ? cloneLayer(layer) : layer,
    );
    const sourceLayer = Array.isArray(nextLayers[layerIndex]) ? [...nextLayers[layerIndex]] : [];
    const destLayer = Array.isArray(nextLayers[layerIndex + 1])
        ? [...nextLayers[layerIndex + 1]]
        : [];

    const toMerge = sourceLayer.splice(0, mergeCount);
    if (layerIndex === 0) {
        carryPromotedLayer0State({ promotedSnippets: toMerge, remainingLayer: sourceLayer });
    }
    destLayer.push(promotedSnippet);
    nextLayers[layerIndex] = sourceLayer;
    nextLayers[layerIndex + 1] = destLayer;
    return nextLayers;
}

function cloneLayer(layer) {
    return layer.map((snippet) => ({ ...snippet }));
}

async function wouldViolateLayer0RetentionFloor({
    layerIndex,
    layers,
    mergeCount,
    settings,
    quota,
}) {
    if (layerIndex !== 0) {
        return false;
    }

    const projectedLayers = buildHypotheticalLayer0AfterPromotion(layers, mergeCount);
    const usage = await getEffectiveMemoryUsage(projectedLayers, settings);
    const projectedTokens = getTokenCountsByLayer(usage).get(0) || 0;
    const floor = Math.floor(quota * LAYER0_PROMOTION_RETENTION_FLOOR_RATIO);
    return projectedTokens < floor;
}

function buildHypotheticalLayer0AfterPromotion(layers, mergeCount) {
    const sourceLayers = Array.isArray(layers) ? layers : [];
    const nextLayers = sourceLayers.map((layer) =>
        Array.isArray(layer) ? cloneLayer(layer) : layer,
    );
    const sourceLayer = Array.isArray(nextLayers[0]) ? [...nextLayers[0]] : [];
    const promotedSnippets = sourceLayer.splice(0, mergeCount);
    carryPromotedLayer0State({ promotedSnippets, remainingLayer: sourceLayer });
    nextLayers[0] = sourceLayer;
    return nextLayers;
}

function buildPromotedSnippet(text, metadata) {
    return {
        text,
        ...metadata,
    };
}

function carryPromotedLayer0State({ promotedSnippets, remainingLayer }) {
    if (!Array.isArray(remainingLayer) || remainingLayer.length === 0) {
        return;
    }
    if (remainingLayer.some((snippet) => isSnapshotStateSnippet(snippet))) {
        return;
    }

    const carryState = buildLayer0CarryState(promotedSnippets, remainingLayer[0]);
    if (Object.keys(carryState).length === 0) {
        return;
    }

    const target = remainingLayer[0];
    const parsed = parseSnippet(target.text || '');
    const mergedState = mergeStates([carryState, parsed.state]);
    const stateText = serializeState(mergedState);
    target.text = stateText
        ? ['[NARRATIVE]', parsed.narrative.trim(), '', stateText].join('\n').trim()
        : parsed.narrative.trim();

    if (carryState.current_date_time && !target.currentDateTime) {
        target.currentDateTime = carryState.current_date_time;
    }
}

function buildLayer0CarryState(promotedSnippets, oldestRemainingSnippet) {
    const promotedState = mergeStates(
        (promotedSnippets || []).map((snippet) => parseSnippet(snippet?.text || '').state),
    );
    const remainingState = parseSnippet(oldestRemainingSnippet?.text || '').state;
    const carryState = /** @type {Record<string, string>} */ ({});

    const hooks = filterCarryHooks(promotedState.hooks);
    if (hooks) {
        carryState.hooks = hooks;
    }
    if (promotedState.dynamics) {
        carryState.dynamics = promotedState.dynamics;
    }
    if (promotedState.inventory) {
        carryState.inventory = promotedState.inventory;
    }
    if (promotedState.counters) {
        carryState.counters = promotedState.counters;
    }
    if (promotedState.current_date_time && !remainingState.current_date_time) {
        carryState.current_date_time = promotedState.current_date_time;
    }

    return carryState;
}

function filterCarryHooks(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    const entries = text
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .filter(
            (entry) =>
                !/\b(resolved|complete|completed|done|closed|cancelled|canceled)\b/i.test(entry),
        );
    return entries.join('; ');
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
 * @param {object} p.promotedSnippet
 * @returns {Promise<boolean>}
 */
async function applyMergePromotion({ snapshot, layerIndex, promotedSnippet }) {
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
    if (layerIndex === 0) {
        carryPromotedLayer0State({ promotedSnippets: toMerge, remainingLayer: layer });
    }

    destLayer.push({
        ...promotedSnippet,
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
