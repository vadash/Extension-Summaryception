import { MICROFICHE_GEOMETRY_PRESETS, defaultSettings } from '../foundation/constants.js';
import { resolveMicroficheEffectiveCap } from './microfiche-policy.js';

// Image-token billing for the Microfiche preview: the estimate the catalogue
// assigns to one rendered frame of the selected preset geometry. Text cost
// stays build-once/measure-built-text so identical text bills identically.
/**
 * @param {Record<string, unknown>} settings
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 */
function microficheImageTokens(settings, host = null) {
    const source = settings ?? {};
    const name = String(source.microficheGeometry ?? '');
    const preset = MICROFICHE_GEOMETRY_PRESETS[name];
    const presetRecord = /** @type {Record<string, unknown>} */ (preset ?? {});
    const frameTokens = Number(presetRecord.frameTokenEstimate);
    if (!Number.isFinite(frameTokens) || frameTokens <= 0) {
        return 0;
    }
    const presetBudget = 'imageBudget' in presetRecord ? presetRecord.imageBudget : undefined;
    const hostBudget =
        host !== null && host !== undefined
            ? /** @type {{ imageBudget?: unknown }} */ (host).imageBudget
            : undefined;
    const images = resolveMicroficheEffectiveCap(
        source.microficheImageCap,
        hostBudget,
        presetBudget,
    );
    return images * frameTokens;
}

// One source of per-layer size policy: Layer 0 output bounds, promotion
// quotas, and the repair ceiling all derive from these ratios.
export const TOKENS_PER_SENTENCE = 35;
export const LAYER_MIN_RATIO = { l0: 0.4, l1: 0.4, l2: 0.3 };
export const LAYER_HARD_MAX_RATIO = { l0: 1.5, l1: 1.75, l2: 1.5 };
export const LAYER0_REPAIR_RATIO = 1.65;
export const LAYER_SAFETY_MULTIPLIER = { l0: 0.85, l1: 0.5, l2: 0.5 };

/**
 * Source token count above which a summarizer output must clear a minimum
 * narrative size (integrity check and Layer 0 narrative minimum gating).
 */
export const SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD = 500;

/**
 * Integer sentence cap for a layer, derived from the configured token target.
 * @param {'l0' | 'l1' | 'l2' | number} layer
 * @param {number | undefined} targetTokens
 * @returns {number}
 */
export function computeSentenceCap(layer, targetTokens) {
    const key = getLayerKey(layer);
    const target = Number(targetTokens);
    if (!Number.isFinite(target) || target <= 0) {
        return 1;
    }
    const raw = Math.floor(
        (LAYER_HARD_MAX_RATIO[key] * target * LAYER_SAFETY_MULTIPLIER[key]) / TOKENS_PER_SENTENCE,
    );
    return Math.max(1, raw);
}

/**
 * @param {'l0' | 'l1' | 'l2' | number} layer
 * @returns {'l0' | 'l1' | 'l2'}
 */
function getLayerKey(layer) {
    if (layer === 'l0' || layer === 0) {
        return 'l0';
    }
    if (layer === 'l1') {
        return 'l1';
    }
    return 'l2';
}

/**
 * Format a countable size-cap line shared by L0 and L1+ prompt blocks.
 * @param {object} p
 * @param {string} p.label
 * @param {number} p.cap
 * @param {string} p.unit
 * @param {string} [p.verb]
 * @param {string} [p.extra]
 * @returns {string}
 */
export function buildSizeTargetLine({ label, cap, unit, verb = '', extra = '' }) {
    const verbClause = verb ? `${verb} ` : '';
    const base = `${label}: ${verbClause}at most ${cap} ${unit}.`;
    return extra ? `${base} ${extra}` : base;
}

/**
 * The Layer 0 source budget block. The sentence cap lives in the recall
 * limits, so the payload stays number-free and identical for every call of
 * the family.
 */
export const LAYER0_BUDGET_HINT = [
    '<budget>',
    'source: compress the passage hard.',
    '</budget>',
].join('\n');

/**
 * Resolve the source-side token count for a summarizer call.
 * @param {import('./call-profile.js').CallProvenance} [provenance]
 * @returns {number}
 */
export function getSourceTokenCount(provenance = {}) {
    const candidates = [
        provenance.sourceTokensBefore,
        provenance.regexStats?.finalTokens,
        provenance.memoryTokensBefore,
    ];
    for (const value of candidates) {
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) {
            return count;
        }
    }
    return 0;
}

/** Overhead of the surrounding SillyTavern prompt in the main-request preview. */
const PREVIEW_BASE_PROMPT_OVERHEAD = 2000;
/** Fixed allowance for deep-layer snippets in the L1 preview line. */
const PREVIEW_DEEP_MEMORY_OVERHEAD = 1000;

/**
 * Estimate the injected-context sizes shown by the settings preview panel.
 * Text terms bill from token budgets only; Microfiche image billing adds
 * the effective image count times the preset frame rate on the main-call line.
 * @param {ReturnType<typeof import('../foundation/settings.js').getSettings>} settings
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 */
export function estimateContextPreview(settings, host = null) {
    const memoryBudget = readTokenSetting(settings, 'memoryTokenBudget');
    const verbatimBudget = readTokenSetting(settings, 'verbatimTokenBudget');
    const queuedBudget = readTokenSetting(settings, 'queuedTokenBudget');
    const minL0Source = readTokenSetting(settings, 'minSummaryBudget');
    const maxL0Source = readTokenSetting(settings, 'maxL0SourceTokens');
    const snippetsPerPromotion = readTokenSetting(settings, 'snippetsPerPromotion');
    const summaryTarget = readTokenSetting(settings, 'layer0SummaryTokenTarget');
    const imageTokens = microficheImageTokens(
        /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (settings ?? {})),
        host,
    );
    return {
        rawChatMin: verbatimBudget,
        rawChatMax: verbatimBudget + queuedBudget,
        mainMin: memoryBudget + verbatimBudget + imageTokens,
        mainMax: memoryBudget + verbatimBudget + queuedBudget + imageTokens,
        l0Typical: minL0Source + memoryBudget + PREVIEW_BASE_PROMPT_OVERHEAD,
        l0Max: maxL0Source + memoryBudget + PREVIEW_BASE_PROMPT_OVERHEAD,
        l1Total:
            snippetsPerPromotion * summaryTarget +
            Math.round(memoryBudget * LAYER_SAFETY_MULTIPLIER.l1) +
            PREVIEW_DEEP_MEMORY_OVERHEAD,
    };
}

/**
 * Read a numeric token setting, falling back to its default when unset or invalid.
 * @param {object} settings
 * @param {string} key
 * @returns {number}
 */
function readTokenSetting(settings, key) {
    const number = Number(settings[key]);
    return Number.isFinite(number) ? number : defaultSettings[key];
}
