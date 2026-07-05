import { defaultSettings } from '../foundation/constants.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MAX_LAYER0_TARGET_TOKENS = 400;
const LAYER0_RESPONSE_TOKEN_BUFFER = 50;

/**
 * Check whether a summarizer call should receive Layer 0 compression controls.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {boolean}
 */
export function isLayer0CompressionCall(metadata = {}) {
    return metadata.kind === 'layer0' || metadata.kind === 'regenerate';
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
 * Compute the provider response cap for a Layer 0 summary.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {number}
 */
export function getLayer0ResponseTokenCap(settings = {}) {
    return getLayer0SummaryTokenTarget(settings) + LAYER0_RESPONSE_TOKEN_BUFFER;
}

/**
 * Add non-persisted Layer 0 output constraints to the final prompt.
 * @param {string} prompt
 * @param {Partial<ExtensionSettings>} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {string}
 */
export function appendLayer0PromptConstraints(prompt, settings, metadata = {}) {
    if (!isLayer0CompressionCall(metadata)) {
        return prompt;
    }

    const target = getLayer0SummaryTokenTarget(settings);
    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_l0_constraints>\n' +
        `Target length: at most about ${target} tokens.\n` +
        'Output exactly one dense paragraph with no heading, list, preamble, or markdown.\n' +
        'Preserve only durable chronology, relationship/state changes, plans, constraints, current position, and unresolved hooks.\n' +
        'Include one full date/time anchor when present, e.g. Saturday Oct 19, 7PM.\n' +
        'After that, use coarse hour labels like 8AM or 7PM; avoid minute tracking unless essential.\n' +
        'Do not preserve only vague relative timing when absolute date/time can be inferred from context.\n' +
        'For future goals/plans, prefer full dates over bare weekdays when available.\n' +
        'Omit repeated micro-actions, flavor dialogue, sensory detail, and transient atmosphere unless they create lasting state.\n' +
        'When detail competes with length, keep the fact needed for future continuity and drop the scene replay.\n' +
        '</summaryception_l0_constraints>'
    );
}
