import { defaultSettings } from '../foundation/constants.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MAX_LAYER0_TARGET_TOKENS = 500;
const MIN_PROMOTION_TARGET_TOKENS = 120;
const LAYER0_RESPONSE_TOKEN_BUFFER = 50;
const MAX_LAYER0_RESPONSE_TOKENS = 384;
const MIN_PROMOTION_RESPONSE_TOKENS = 512;
const MAX_PROMOTION_RESPONSE_TOKENS = 2048;
const PROMOTION_RESPONSE_TOKENS_PER_SNIPPET = 256;
const PROMOTION_RESPONSE_TOKEN_BUFFER = 200;
const PROMOTION_TARGET_RATIO = 0.4;

/**
 * Check whether a summarizer call should receive runtime compression controls.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {boolean}
 */
export function isLayer0CompressionCall(metadata = {}) {
    return (
        metadata.kind === 'layer0' ||
        metadata.kind === 'regenerate' ||
        metadata.kind === 'promotion'
    );
}

/**
 * Normalize the configured Layer 0 summary target.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {number}
 */
export function getLayer0SummaryTokenTarget(settings = {}) {
    const parsed = Number(settings.layer0SummaryTokenTarget);
    const fallback = defaultSettings.layer0SummaryTokenTarget;
    const value = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    return Math.min(MAX_LAYER0_TARGET_TOKENS, Math.max(MIN_LAYER0_TARGET_TOKENS, value));
}

/**
 * Compute the provider response cap for a summary or promotion.
 * @param {Partial<ExtensionSettings>} [settings]
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {number|null}
 */
export function getLayer0ResponseTokenCap(settings = {}, metadata = {}) {
    if (metadata.kind === 'promotion') {
        const target = getPromotionSummaryTokenTarget(metadata);
        const effectiveTarget = target === null ? MIN_PROMOTION_RESPONSE_TOKENS : target;
        const mergedCount =
            Number(metadata.mergedSnippetCount) || settings.snippetsPerPromotion || 3;
        const scaledCap =
            effectiveTarget +
            mergedCount * PROMOTION_RESPONSE_TOKENS_PER_SNIPPET +
            PROMOTION_RESPONSE_TOKEN_BUFFER;
        return Math.min(
            Math.max(scaledCap, MIN_PROMOTION_RESPONSE_TOKENS),
            MAX_PROMOTION_RESPONSE_TOKENS,
        );
    }
    return Math.min(
        getLayer0SummaryTokenTarget(settings) + LAYER0_RESPONSE_TOKEN_BUFFER,
        MAX_LAYER0_RESPONSE_TOKENS,
    );
}

/**
 * Add non-persisted compression constraints to the final prompt.
 * @param {string} prompt
 * @param {Partial<ExtensionSettings>} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {string}
 */
export function appendLayer0PromptConstraints(prompt, settings, metadata = {}) {
    if (!isLayer0CompressionCall(metadata)) {
        return prompt;
    }

    if (metadata.kind === 'promotion') {
        return appendPromotionPromptConstraints(prompt, metadata);
    }

    const target = getLayer0SummaryTokenTarget(settings);
    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_l0_constraints>\n' +
        `Target length: at most about ${target} tokens.\n` +
        'Output exactly [NARRATIVE] and [STATE] sections with no preamble or markdown code block.\n' +
        '[NARRATIVE] must be one dense paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags there.\n' +
        '[STATE] must contain only changed or newly relevant dynamic current facts as key: value lines; omit unchanged facts.\n' +
        '[STATE] must not include static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.\n' +
        'Do NOT write descriptive sentences in the state block. Use concise keys and values only.\n' +
        'Use key: none only when a durable fact is explicitly resolved, emptied, or removed.\n' +
        'Include one full date/time anchor when present, e.g. Saturday Oct 19, 7PM.\n' +
        'After that, use coarse hour labels like 8AM or 7PM; avoid minute tracking unless essential.\n' +
        'Do not preserve only vague relative timing when absolute date/time can be inferred from context.\n' +
        'For future goals/plans, prefer full dates over bare weekdays when available.\n' +
        'Omit repeated micro-actions, flavor dialogue, sensory detail, and transient atmosphere unless they create lasting state.\n' +
        'When detail competes with length, keep the fact needed for future continuity and drop the scene replay.\n' +
        '</summaryception_l0_constraints>'
    );
}

/**
 * Compute the target size for a Layer 1+ promotion from source memory size.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {number|null}
 */
function getPromotionSummaryTokenTarget(metadata = {}) {
    const sourceTokens = Number(metadata.memoryTokensBefore);
    if (!Number.isFinite(sourceTokens) || sourceTokens <= 0) {
        return null;
    }
    return Math.max(MIN_PROMOTION_TARGET_TOKENS, Math.round(sourceTokens * PROMOTION_TARGET_RATIO));
}

/**
 * Add Layer 1+ promotion-specific consolidation constraints.
 * @param {string} prompt
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function appendPromotionPromptConstraints(prompt, metadata = {}) {
    const target = getPromotionSummaryTokenTarget(metadata);
    const targetLine =
        target === null
            ? 'Target length: make the output significantly shorter than the combined input memories.\n'
            : `Target length: at most about ${target} tokens, roughly 40% of the combined input memories.\n`;

    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_promotion_constraints>\n' +
        targetLine +
        'Output exactly two sections: [NARRATIVE] and [STATE].\n' +
        '[NARRATIVE] must be one dense paragraph with no heading, list, preamble, or markdown.\n' +
        'Preserve only durable chronology, relationship/state changes, permanent rules, current position, and unresolved hooks.\n' +
        'Preserve useful full date/time anchors already present in memory.\n' +
        'Do not repeat or re-summarize events already established in prior context.\n' +
        'Deduplicate related events and merge repeated beats into one cumulative state change or outcome.\n' +
        'Omit low-impact micro-actions, scene replay, flavor dialogue, sensory detail, and transient atmosphere.\n' +
        '[NARRATIVE] must contain ONLY story, actions, and events. Do NOT include factual parameters like dates, inventory lists, or status flags there.\n' +
        '[STATE] must contain ONLY consolidated active dynamic facts, counters, and status flags. Omit stale transient scene facts and static character background/profile facts.\n' +
        'Omitted [STATE] keys are treated as no longer active when you output a [STATE] section.\n' +
        'Do NOT write descriptive sentences in the state block.\n' +
        '</summaryception_promotion_constraints>'
    );
}
