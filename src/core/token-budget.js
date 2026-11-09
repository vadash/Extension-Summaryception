import { defaultSettings } from '../foundation/constants.js';
import { frameGrid } from './microfiche-geometry.js';

// Image-token billing for the Microfiche preview: the built injection owns the
// page count and the frame estimate, so the preview and the injected split
// always agree. Image tokens spend from the raw-chat bucket, so they debit the
// same figure the preview reports as rawChatMax. Text cost stays
// build-once/measure-built-text so identical text bills identically.
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

/**
 * The raw-chat bucket image tokens spend from: the Recent and Queued text
 * budgets together. Microfiche policy gates images against this same figure.
 * @param {object | null} [settings] - Settings carrying the raw text budgets.
 * @returns {number} Bucket size in tokens.
 */
export function resolveRawChatBucketTokens(settings = null) {
    return (
        readTokenSetting(settings ?? {}, 'verbatimTokenBudget') +
        readTokenSetting(settings ?? {}, 'queuedTokenBudget')
    );
}

// Held-text tokens use the same 4 characters per token fallback ratio as the
// Microfiche bucket gate, so capacity and text billing share one scale.
const HELD_TEXT_CHARS_PER_TOKEN = 4;

/**
 * Image holds-and-bills figures for the Microfiche cost line. The built
 * injection owns the page count; held text tokens derive from the frame
 * capacity and billed tokens from the preset frame estimate, so the settings
 * line and the context preview agree without tokenizing image text.
 * @param {import('./memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @param {object | null} [settings] - Settings carrying the raw text budgets.
 * @returns {{ images: number, heldTokens: number, imageTokens: number, netTokens: number | null, bucketTokens: number, bucketAfterImages: number } | null}
 */
export function describeMicroficheBilling(injection = null, settings = null) {
    const microfiche = injection?.microfiche;
    if (!microfiche) {
        return null;
    }
    const images = Array.isArray(microfiche.imageTexts) ? microfiche.imageTexts.length : 0;
    const frameTokens = Number(microfiche.frameTokenEstimate);
    const hasFrameEstimate = Number.isFinite(frameTokens) && frameTokens > 0;
    const capacity = microfiche.shape ? frameGrid(microfiche.shape).capacity : 0;
    const imageTokens = hasFrameEstimate ? images * frameTokens : 0;
    const heldTokens = Math.round((images * capacity) / HELD_TEXT_CHARS_PER_TOKEN);
    const bucketTokens = resolveRawChatBucketTokens(settings);
    return {
        images,
        heldTokens,
        imageTokens,
        netTokens: hasFrameEstimate ? imageTokens - heldTokens : null,
        bucketTokens,
        bucketAfterImages: Math.max(0, bucketTokens - imageTokens),
    };
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
 * built Memory Injection: image tokens spend from the raw-chat bucket, so they
 * debit rawChatMax instead of inflating the total past the bucket. A null
 * injection, or an injection with no Microfiche split, bills no images.
 * @param {ReturnType<typeof import('../foundation/settings.js').getSettings>} settings
 * @param {import('./memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @returns {{ rawChatMin: number, rawChatMax: number, mainMin: number, mainMax: number, l0Typical: number, l0Max: number, l1Total: number }}
 */
export function estimateContextPreview(settings, injection = null) {
    const memoryBudget = readTokenSetting(settings, 'memoryTokenBudget');
    const verbatimBudget = readTokenSetting(settings, 'verbatimTokenBudget');
    const minL0Source = readTokenSetting(settings, 'minSummaryBudget');
    const maxL0Source = readTokenSetting(settings, 'maxL0SourceTokens');
    const snippetsPerPromotion = readTokenSetting(settings, 'snippetsPerPromotion');
    const summaryTarget = readTokenSetting(settings, 'layer0SummaryTokenTarget');
    const imageTokens = microficheInjectionTokens(injection);
    const rawChatMax = Math.max(0, resolveRawChatBucketTokens(settings) - imageTokens);
    const rawChatMin = Math.min(verbatimBudget, rawChatMax);
    return {
        rawChatMin,
        rawChatMax,
        mainMin: memoryBudget + rawChatMin + imageTokens,
        mainMax: memoryBudget + rawChatMax + imageTokens,
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
