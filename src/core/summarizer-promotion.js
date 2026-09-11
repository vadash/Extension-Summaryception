import { INTERNAL_MAX_LAYER_DEPTH, TOAST_TITLE } from '../foundation/constants.js';
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
import { compileGlobalState, parseSnippet, serializeState } from './summarizer-state.js';
import { callSummarizer } from './summarizer-request.js';
import { isSummarizerOutputSafe } from './prompts.js';
import {
    getLayer0SummaryTokenTarget,
    getPromotionSummaryTokenHardMax,
    getPromotionSummaryTokenTarget,
} from './layer0-compression.js';
import { buildRepairDiagnostics } from './repair-diagnostics.js';
import {
    commitWhenSafe,
    isPromptMutationFrozen,
    updateCommittedInjection,
} from './summarizer-commit.js';
import { buildSnapshotBasis, isSnapshotStoreCurrent } from './summarizer-snapshot.js';
import { countTextTokens, formatTokenValue } from './token-count.js';

const MIN_PROMOTION_MERGE_COUNT = 3;
const MAX_PROMOTION_MERGE_COUNT = 4;
const LAYER0_INITIAL_BUDGET_RATIO = 0.6;
const LAYER0_DEEP_BUDGET_RATIO = 0.5;
const LAYER1_BUDGET_RATIO = 0.3;
const DEEP_LAYER_BUDGET_RATIO = 0.2;
const LAYER0_PROMOTION_RETENTION_FLOOR_RATIO = 0.4;

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
    const countExceeded = quota.count > settings.snippetsPerLayer;
    const tokenExceeded = quota.tokens > quota.quota;
    if (!countExceeded && !tokenExceeded) {
        return false;
    }
    const minimumCount = getEffectivePromotionBatchSize(settings);
    if (quota.count < minimumCount) {
        if (tokenExceeded) {
            warn(
                `Promotion L${quota.layerIndex} blocked: ${quota.tokens} tokens exceed quota ` +
                    `${quota.quota}, but only ${quota.count} snippets are available; at least ` +
                    `${minimumCount} are required.`,
            );
        }
        return false;
    }
    return true;
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

    const storyTxt = toMerge
        .map((snippet) => formatAnchoredSnippetNarrative(snippet))
        .filter(Boolean)
        .join('\n\n');
    const sourceNarrativeText = storyTxt;
    const mergedState = compileGlobalState([toMerge]);
    const serializedState = serializeState(mergedState);
    const sourceState = serializedState || '(none)';
    const memoryTokensBefore = await countTextTokens(storyTxt);
    const contextStr = buildFullContext(layerIndex + 1);
    const promotedMetadata = buildPromotedSnippetMetadata(toMerge);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt: sourceNarrativeText,
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
        sourceNarrativeText,
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
        TOAST_TITLE,
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
        sourceNarrativeText: prepared.sourceNarrativeText,
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
        await drainPromotionOverflow({
            maxFailures: 1,
            isBlockedBefore: isPromptMutationFrozen,
            isBlockedAfter: isPromptMutationFrozen,
        });
    }
    return result !== 'stale';
}

async function buildValidatedPromotionSnippet({
    layerIndex,
    mergeCount,
    settings,
    sourceNarrativeText,
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
        sourceNarrativeText,
        sourceTokens,
    });
    if (firstValidation.valid) {
        return firstCandidate;
    }

    if (
        (firstValidation.reason !== 'compression-ratio' &&
            firstValidation.reason !== 'too-short') ||
        !firstValidation.outputTokens ||
        !firstValidation.sourceTokens
    ) {
        return null;
    }

    const repairNarrative = await callSummarizer(storyTxt, contextStr, {
        ...metadata,
        promotionRepair: {
            reason: firstValidation.reason,
            outputTokens: firstValidation.outputTokens.count,
            targetTokens: firstValidation.targetTokens,
            hardMaxTokens: firstValidation.hardMaxTokens,
            requiredMaxTokens: firstValidation.requiredMaxTokens,
            sourceTokens: firstValidation.sourceTokens.count,
            rejectedSummary: firstCandidate.text,
            diagnostics: firstValidation.diagnostics,
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
        sourceNarrativeText,
        sourceTokens,
    });
    return repairedValidation.valid ? repairedCandidate : null;
}

function buildPromotionCandidate(narrative, promotedMetadata) {
    const metaSummary = parseSnippet(narrative).narrative.trim();
    if (!metaSummary) {
        return null;
    }
    const cleanSummary = formatSnippetAnchor(promotedMetadata)
        ? stripLeadingSnippetAnchor(metaSummary)
        : metaSummary;
    if (!cleanSummary) {
        return null;
    }
    return { text: cleanSummary, ...promotedMetadata };
}

async function validatePromotionCandidate({
    layerIndex,
    mergeCount,
    promotedSnippet,
    settings,
    sourceNarrativeText,
    sourceTokens: providedSourceTokens,
}) {
    const sourceTokens = providedSourceTokens || (await countTextTokens(sourceNarrativeText));
    const sizeValidation = await validatePromotionSize({
        layerIndex,
        promotedSnippet,
        settings,
        sourceTokens,
    });
    if (!sizeValidation.valid) {
        return sizeValidation;
    }
    return validatePromotionCompressesMemory({ layerIndex, mergeCount, promotedSnippet, settings });
}

async function validatePromotionSize({ layerIndex, promotedSnippet, settings, sourceTokens }) {
    if (!isPromotionSummarySafe({ layerIndex, promotedSnippet, sourceTokens })) {
        return { valid: false, reason: 'integrity' };
    }
    const outputTokens = await countTextTokens(promotedSnippet.text);
    const targetTokens = getLayer0SummaryTokenTarget(settings);
    const minTokens = getPromotionSummaryTokenTarget({ layerIndex, targetTokens });
    const hardMaxTokens = getPromotionSummaryTokenHardMax({ layerIndex, targetTokens });
    const tooShort = outputTokens.count < minTokens;
    if (outputTokens.count > hardMaxTokens || tooShort) {
        return rejectPromotionSize({
            layerIndex,
            promotedSnippet,
            sourceTokens,
            outputTokens,
            minTokens,
            hardMaxTokens,
            tooShort,
        });
    }
    return { valid: true };
}

async function validatePromotionCompressesMemory({
    layerIndex,
    mergeCount,
    promotedSnippet,
    settings,
}) {
    const store = getChatStore();
    const memoryTokensBefore = await getEffectiveMemoryUsage(store.layers, settings);
    const nextLayers = buildHypotheticalLayersAfterPromotion(
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

function isPromotionSummarySafe({ layerIndex, promotedSnippet, sourceTokens }) {
    return isSummarizerOutputSafe(
        promotedSnippet.text,
        {
            kind: 'promotion',
            memoryTokensBefore: sourceTokens.count,
            memoryTokensBeforeEstimated: sourceTokens.estimated,
        },
        `Promotion L${layerIndex} rejected: `,
    );
}

function rejectPromotionSize({
    layerIndex,
    promotedSnippet,
    sourceTokens,
    outputTokens,
    minTokens,
    hardMaxTokens,
    tooShort,
}) {
    const diagnostics = buildRepairDiagnostics({
        scope: 'Layer 1+ promotion',
        totalTokens: outputTokens.count,
        sections: [
            {
                id: 'draft',
                label: '[NARRATIVE]',
                actualTokens: outputTokens.count,
                targetTokens: minTokens,
                hardMaxTokens,
                ...(tooShort ? { minimumTokens: minTokens } : {}),
                text: promotedSnippet.text,
                repairInstruction: tooShort
                    ? 'expand the fold: it over-merged; restore the dropped durable beats'
                    : 'rewrite as macro-level prose only; remove dialogue, scene replay, micro-actions, and transient detail',
                preservationInstruction:
                    'retain only macro-level durable chronology and continuity',
            },
        ],
        rejectedDraft: promotedSnippet.text,
    });
    warn(
        tooShort
            ? `Promotion L${layerIndex} rejected: output under the over-merge floor ` +
                  `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                  `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens; ` +
                  `minimum ${formatTokenValue(minTokens, sourceTokens.estimated)}).`
            : `Promotion L${layerIndex} rejected: output exceeded the compression hard maximum ` +
                  `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                  `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens; ` +
                  `target ${formatTokenValue(minTokens, sourceTokens.estimated)}, ` +
                  `hard maximum ${formatTokenValue(hardMaxTokens, sourceTokens.estimated)}).`,
    );
    return {
        valid: false,
        reason: tooShort ? 'too-short' : 'compression-ratio',
        sourceTokens,
        outputTokens,
        targetTokens: minTokens,
        hardMaxTokens,
        requiredMaxTokens: hardMaxTokens,
        diagnostics,
    };
}

function buildHypotheticalLayersAfterPromotion(layers, layerIndex, mergeCount, promotedSnippet) {
    const sourceLayers = Array.isArray(layers) ? layers : [];
    const nextLayers = sourceLayers.map((layer) => (Array.isArray(layer) ? [...layer] : layer));
    const sourceLayer = Array.isArray(nextLayers[layerIndex]) ? [...nextLayers[layerIndex]] : [];
    sourceLayer.splice(0, mergeCount);
    nextLayers[layerIndex] = sourceLayer;
    if (!promotedSnippet) {
        return nextLayers;
    }
    const destLayer = Array.isArray(nextLayers[layerIndex + 1])
        ? [...nextLayers[layerIndex + 1]]
        : [];
    destLayer.push(promotedSnippet);
    nextLayers[layerIndex + 1] = destLayer;
    return nextLayers;
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

    const projectedLayers = buildHypotheticalLayersAfterPromotion(layers, 0, mergeCount);
    const usage = await getEffectiveMemoryUsage(projectedLayers, settings);
    const projectedTokens = getTokenCountsByLayer(usage).get(0) || 0;
    const floor = Math.floor(quota * LAYER0_PROMOTION_RETENTION_FLOOR_RATIO);
    return projectedTokens < floor;
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
        ...buildSnapshotBasis({ chatRef: ctx.chat, store, ctx }),
        layerIndex,
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
    if (!isSnapshotStoreCurrent(snapshot, getContext(), getChatStore())) {
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
        ...promotedSnippet,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });
    store.layers[layerIndex + 1] = destLayer;
    bumpSummaryStoreMutationEpoch(store);

    await saveChatStore();
    await updateCommittedInjection({ logMemoryStatus: true });

    return true;
}

/**
 * Drain promotion overflow until layers fit, a guard blocks, or consecutive
 * failed promotions reach `maxFailures`.
 * @param {object} [options]
 * @param {number} [options.maxFailures] - Consecutive failed promotions tolerated before stopping.
 * @param {() => boolean} [options.isBlockedBefore] - Guard checked before each promotion attempt.
 * @param {() => boolean} [options.isBlockedAfter] - Guard checked after each promotion attempt.
 * @returns {Promise<'normalized'|'blocked'|'failed'>}
 */
export async function drainPromotionOverflow({
    maxFailures = Infinity,
    isBlockedBefore = () => false,
    isBlockedAfter = () => false,
} = {}) {
    let failures = 0;
    while (await hasPromotionOverflow(0)) {
        if (isBlockedBefore()) {
            return 'blocked';
        }
        const promoted = await maybePromoteLayer(0);
        if (isBlockedAfter()) {
            return 'blocked';
        }
        if (promoted) {
            failures = 0;
        } else {
            failures++;
            if (failures >= maxFailures) {
                return 'failed';
            }
        }
    }
    return 'normalized';
}
