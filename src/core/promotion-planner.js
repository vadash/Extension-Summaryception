import { INTERNAL_MAX_LAYER_DEPTH } from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';
import { buildInjection, measureInjection } from './memory-injection.js';
import { LAYER_HARD_MAX_RATIO, LAYER_MIN_RATIO } from './token-budget.js';

const MIN_PROMOTION_MERGE_COUNT = 3;
const MAX_PROMOTION_MERGE_COUNT = 4;
const LAYER0_INITIAL_BUDGET_RATIO = 0.6;
const LAYER0_DEEP_BUDGET_RATIO = 0.5;
const LAYER1_BUDGET_RATIO = 0.3;
const DEEP_LAYER_BUDGET_RATIO = 0.2;
const LAYER0_PROMOTION_RETENTION_FLOOR_RATIO = 0.4;

/**
 * Compute the target size for a promotion, anchored to the slider target T.
 * Doubles as the acceptance floor: a shorter output is rejected as over-merged.
 * @param {object} p
 * @param {number} p.layerIndex - Promotion SOURCE layer (0 => produces L1, >=1 => L2+).
 * @param {number} p.targetTokens - Slider target T.
 * @returns {number}
 */
export function getPromotionSummaryTokenTarget({ layerIndex, targetTokens }) {
    const key = Number(layerIndex) >= 1 ? 'l2' : 'l1';
    return Math.max(1, Math.floor(targetTokens * LAYER_MIN_RATIO[key]));
}

/**
 * Compute the hard maximum size for a promotion, anchored to the slider
 * target T.
 * @param {object} p
 * @param {number} p.layerIndex - Promotion SOURCE layer (0 => produces L1, >=1 => L2+).
 * @param {number} p.targetTokens - Slider target T.
 * @returns {number}
 */
export function getPromotionSummaryTokenHardMax({ layerIndex, targetTokens }) {
    const key = Number(layerIndex) >= 1 ? 'l2' : 'l1';
    return Math.max(1, Math.round(targetTokens * LAYER_HARD_MAX_RATIO[key]));
}

/**
 * Build normalized token quotas for active non-empty layers.
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<Array<{ layerIndex: number, quota: number, tokens: number, count: number, totalTokens: number, tokenBudgetExceeded: boolean }>>}
 */
async function buildLayerMemoryQuotas(store, settings) {
    const active = getActiveLayers(store);
    if (active.length === 0) {
        return [];
    }

    const usage = await measureInjection(buildInjection(store.layers, settings));
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
 * Build the read model consumed by one promotion drain iteration: per-layer
 * quotas, the effective merge count, the first promotable over-limit candidate
 * (shallowest layer upward), and whether promoting that candidate would breach
 * the Layer 0 retention floor.
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<{
 *   quotas: Array<{ layerIndex: number, quota: number, tokens: number, count: number, totalTokens: number, tokenBudgetExceeded: boolean }>,
 *   mergeCount: number,
 *   candidate: { layerIndex: number, quota: number, tokens: number, count: number } | null,
 *   retentionFloorViolated: boolean,
 * }>}
 */
export async function buildPromotionPlan(store, settings) {
    const quotas = await buildLayerMemoryQuotas(store, settings);
    const mergeCount = getEffectivePromotionBatchSize(settings);
    const quota = quotas.find(
        (entry) => isLayerOverLimit(entry, settings) && canPromoteLayer(entry.layerIndex),
    );
    const candidate = quota
        ? {
              layerIndex: quota.layerIndex,
              quota: quota.quota,
              tokens: quota.tokens,
              count: quota.count,
          }
        : null;
    const retentionFloorViolated = candidate
        ? await wouldViolateLayer0RetentionFloor({
              layerIndex: candidate.layerIndex,
              layers: store.layers,
              mergeCount,
              settings,
              quota: candidate.quota,
          })
        : false;
    return { quotas, mergeCount, candidate, retentionFloorViolated };
}

/**
 * Project the layers after one promotion: the source layer loses its first
 * `mergeCount` snippets and the destination layer gains the promoted snippet.
 * @param {Array<Array<object>>} layers
 * @param {number} layerIndex - Promotion SOURCE layer.
 * @param {number} mergeCount
 * @param {object} [promotedSnippet] - When omitted, only the splice is projected.
 * @returns {Array<Array<object>>}
 */
export function buildHypotheticalLayersAfterPromotion(
    layers,
    layerIndex,
    mergeCount,
    promotedSnippet,
) {
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
    const usage = await measureInjection(buildInjection(projectedLayers, settings));
    const projectedTokens = getTokenCountsByLayer(usage).get(0) || 0;
    const floor = Math.floor(quota * LAYER0_PROMOTION_RETENTION_FLOOR_RATIO);
    return projectedTokens < floor;
}
