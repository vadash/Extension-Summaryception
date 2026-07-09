import { defaultSettings } from '../foundation/constants.js';
import { ENGLISH_FIRST_LANGUAGE_RULE, ANTI_RUN_ON_RULE } from '../foundation/prompt-constants.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MAX_LAYER0_TARGET_TOKENS = 500;
const MIN_PROMOTION_TARGET_TOKENS = 120;
const PROMOTION_TARGET_RATIO = 0.4;
const ENGLISH_FIRST_LANGUAGE_RULE_WITH_NEWLINE = ENGLISH_FIRST_LANGUAGE_RULE + '\n';

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
    const sourceRangeLine = buildLayer0SourceRangeLine(metadata);
    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_l0_constraints>\n' +
        `Target length: at most about ${target} tokens.\n` +
        sourceRangeLine +
        ENGLISH_FIRST_LANGUAGE_RULE_WITH_NEWLINE +
        'Output exactly [NARRATIVE] and [STATE] sections with no preamble or markdown code block.\n' +
        '[NARRATIVE] must be one dense paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags there.\n' +
        ANTI_RUN_ON_RULE +
        '\n' +
        '[STATE] must contain only changed or newly relevant dynamic current facts as key: value lines; omit unchanged facts.\n' +
        '[STATE] must always include current_date_time.\n' +
        'Use temporal format YYYY-MM-DD HH ddd with 24-hour, hour-level precision only, e.g. 2024-12-03 06 Wed; drop minutes instead of preserving them.\n' +
        'Normalize time from raw bracket headers or passage timestamps when present; if no explicit passage time appears, carry forward prior current_date_time.\n' +
        '[STATE] must not include static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.\n' +
        'Do NOT write descriptive sentences in the state block. Use concise keys and values only.\n' +
        'Use key: none only when a durable fact is explicitly resolved, emptied, or removed.\n' +
        'Treat [STATE] as durable state, not ephemeral trivia.\n' +
        'Do not preserve physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, or momentary pose/arousal/mood counters.\n' +
        'Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by unresolved hooks.\n' +
        'Omit repeated micro-actions, flavor dialogue, sensory detail, and transient atmosphere unless they create lasting state.\n' +
        'When detail competes with length, keep the fact needed for future continuity and drop the scene replay.\n' +
        '</summaryception_l0_constraints>'
    );
}

function buildLayer0SourceRangeLine(metadata = {}) {
    const range = metadata.sourceRange;
    if (!Array.isArray(range) || range.length < 2) {
        return '';
    }
    return (
        `This passage covers chat messages ${range[0]}-${range[1]}. ` +
        `Message ${range[1]} is the latest summarized message. ` +
        'current_date_time must be the scene time at the end of that message.\n'
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
    const repairLine = buildPromotionRepairLine(metadata);

    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_promotion_constraints>\n' +
        targetLine +
        repairLine +
        ENGLISH_FIRST_LANGUAGE_RULE_WITH_NEWLINE +
        'Read the [NARRATIVE] and [STATE] segments of the provided memory snippets.\n' +
        'Output exactly one [NARRATIVE] section. Do not output a [STATE] block.\n' +
        '[NARRATIVE] must be exactly one dense paragraph with no heading, list, preamble, markdown, or blank line inside it.\n' +
        '[NARRATIVE] must contain no more than 4 to 5 sentences total.\n' +
        ANTI_RUN_ON_RULE +
        '\n' +
        'Fold any critical changes in state, inventory, counters, or character dynamics directly into the prose.\n' +
        'Do not use key-value formatting, bullet lists, tables, or structured state syntax.\n' +
        'Preserve only macro-level durable chronology, relationship/state changes, permanent rules, current position, and unresolved hooks.\n' +
        'Preserve anchored source ranges and hour-level 24-hour timestamps already present in memory, e.g. [msgs 100-120; current 2024-12-03 09 Wed].\n' +
        'Do not invent broad dates for unknown spans; only clean unknown spans when bounded by explicit neighboring anchors.\n' +
        'Omit physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, and momentary pose/arousal/mood counters.\n' +
        'Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by unresolved hooks.\n' +
        'Do not repeat or re-summarize events already established in prior context.\n' +
        'Deduplicate related events and merge repeated beats into one cumulative state change or outcome.\n' +
        'Omit all dialogue, low-impact micro-actions, scene replay, minor subplots, flavor dialogue, sensory detail, and transient atmosphere.\n' +
        '</summaryception_promotion_constraints>'
    );
}

function buildPromotionRepairLine(metadata = {}) {
    if (!metadata.promotionRepair) {
        return '';
    }

    const repair = metadata.promotionRepair;
    const outputTokens = Number(repair.outputTokens);
    const requiredMaxTokens = Number(repair.requiredMaxTokens);
    const tokenLine =
        Number.isFinite(outputTokens) && Number.isFinite(requiredMaxTokens)
            ? `The rejected draft was ${outputTokens} tokens; the repaired output must be ${requiredMaxTokens} tokens or fewer.\n`
            : '';
    const rejected = String(repair.rejectedSummary || '').trim();
    const rejectedBlock = rejected
        ? `<rejected_promotion_draft>\n${rejected}\n</rejected_promotion_draft>\n`
        : '';

    return (
        'Repair task: the previous promotion draft failed the minimum compression guard.\n' +
        tokenLine +
        'Rewrite it more abstractly instead of appending detail; keep only the durable macro outcome.\n' +
        rejectedBlock
    );
}
