import { defaultSettings } from '../foundation/constants.js';

// Image-token billing for the Microfiche preview: the built injection owns the
// page count and the frame estimate, so the preview and the injected split
// always agree. Text cost stays build-once/measure-built-text so identical
// text bills identically.
/**
 * The injected split is the billing source: page count and frame rate come
 * from it, never from the budget knobs that produced them.
 * @param {import('./memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @returns {number}
 */
function microficheInjectionTokens(injection = null) {
    const microfiche = injection?.microfiche;
    const pages = Array.isArray(microfiche?.imageTexts) ? microfiche.imageTexts.length : 0;
    const frameTokens = Number(microfiche?.frameTokenEstimate);
    if (!Number.isFinite(frameTokens) || frameTokens <= 0) {
        return 0;
    }
    return pages * frameTokens;
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
 * Text terms bill from token budgets only. The main-call line projects the
 * built Memory Injection: it adds the page count and frame estimate carried
 * by that injection's Microfiche split. A null injection, or an injection
 * with no Microfiche split, bills no images.
 * @param {ReturnType<typeof import('../foundation/settings.js').getSettings>} settings
 * @param {import('./memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @returns {{ rawChatMin: number, rawChatMax: number, mainMin: number, mainMax: number, l0Typical: number, l0Max: number, l1Total: number }}
 */
export function estimateContextPreview(settings, injection = null) {
    const memoryBudget = readTokenSetting(settings, 'memoryTokenBudget');
    const verbatimBudget = readTokenSetting(settings, 'verbatimTokenBudget');
    const queuedBudget = readTokenSetting(settings, 'queuedTokenBudget');
    const minL0Source = readTokenSetting(settings, 'minSummaryBudget');
    const maxL0Source = readTokenSetting(settings, 'maxL0SourceTokens');
    const snippetsPerPromotion = readTokenSetting(settings, 'snippetsPerPromotion');
    const summaryTarget = readTokenSetting(settings, 'layer0SummaryTokenTarget');
    const imageTokens = microficheInjectionTokens(injection);
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
