import { defaultSettings } from '../foundation/constants.js';
import {
    ANTI_RUN_ON_RULE,
    ENGLISH_FIRST_LANGUAGE_RULE,
    LAYER0_DURABILITY_RULES,
    PROMOTION_MODERATE_MACRO_RULES,
    STATE_SNAPSHOT_MAX_TOKENS,
    STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
    STATE_DEDUPLICATION_RULES,
} from '../foundation/prompt-constants.js';
import { buildRepairDiagnostics, formatRepairDiagnostics } from './repair-diagnostics.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MAX_LAYER0_TARGET_TOKENS = 500;
const LAYER0_MIN_OUTPUT_RATIO = 1 / 3;
const LAYER0_MAX_OUTPUT_RATIO = 1.5;
const LAYER0_REPAIR_MAX_OUTPUT_RATIO = 1.65;
const PROMOTION_TARGET_RATIO = 0.4;
const PROMOTION_HARD_MAX_RATIO = 0.6;
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
 * Compute the accepted Layer 0 output-size band for a configured target.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {{ target: number, min: number, max: number }}
 */
export function getLayer0SummaryTokenBounds(settings = {}) {
    const target = getLayer0SummaryTokenTarget(settings);
    return {
        target,
        min: Math.floor(target * LAYER0_MIN_OUTPUT_RATIO),
        max: Math.round(target * LAYER0_MAX_OUTPUT_RATIO),
    };
}

/**
 * Compute the narrow narrative grace ceiling used to avoid retrying near-miss
 * outputs from slow providers. The model-facing hard maximum remains the
 * normal Layer 0 bound.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {number}
 */
export function getLayer0SummaryRepairCeiling(settings = {}) {
    return Math.round(getLayer0SummaryTokenTarget(settings) * LAYER0_REPAIR_MAX_OUTPUT_RATIO);
}

/**
 * Check whether a summarizer call should receive Layer 0 size validation.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {boolean}
 */
export function isLayer0SizeGuardCall(metadata = {}) {
    return metadata.kind === 'layer0' || metadata.kind === 'regenerate';
}

/**
 * Build attempt-local repair feedback for a rejected Layer 0 output.
 * @param {object} p
 * @param {object} [p.diagnostics]
 * @param {'too-short' | 'too-long'} [p.reason]
 * @param {number} [p.outputTokens]
 * @param {{ target: number, min: number, max: number }} [p.bounds]
 * @returns {string}
 */
export function buildLayer0SizeRepairFeedback({ diagnostics, reason, outputTokens, bounds }) {
    const resolvedDiagnostics =
        diagnostics ||
        buildRepairDiagnostics({
            scope: 'Layer 0',
            totalTokens: outputTokens ?? 0,
            sections: [
                {
                    id: 'narrative',
                    label: '[NARRATIVE]',
                    actualTokens: outputTokens ?? 0,
                    targetTokens: bounds?.target ?? 0,
                    hardMaxTokens: bounds?.max ?? 0,
                    minimumTokens: reason === 'too-short' ? (bounds?.min ?? 0) : 0,
                },
            ],
        });
    return formatRepairDiagnostics(resolvedDiagnostics, {
        wrapperTag: 'summaryception_l0_repair_feedback',
        rejectedSectionTagPrefix: 'rejected_',
    }).replace(
        '</summaryception_l0_repair_feedback>',
        'Aim for each section soft target, not merely its hard maximum. Rewrite only the rejected section or sections. Reproduce every preserved section exactly.\n' +
            'Output exactly one [NARRATIVE] section followed by exactly one [STATE] section.\n' +
            '</summaryception_l0_repair_feedback>',
    );
}

/**
 * Build repair feedback for an oversized state snapshot.
 * @param {object} p
 * @param {number} p.stateTokens
 * @param {string} [p.stateText]
 * @returns {string}
 */
export function buildStateSnapshotSizeRepairFeedback({ stateTokens, stateText = '' }) {
    const diagnostics = buildRepairDiagnostics({
        scope: 'Layer 0',
        totalTokens: stateTokens,
        sections: [
            {
                id: 'state',
                label: '[STATE]',
                actualTokens: stateTokens,
                targetTokens: STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
                hardMaxTokens: STATE_SNAPSHOT_MAX_TOKENS,
                text: stateText,
                repairInstruction:
                    'rewrite the complete snapshot more abstractly and remove transient facts',
                preservationInstruction:
                    'keep only the fixed state keys and the most consequential active continuity',
            },
        ],
        rejectedDraft: stateText,
    });
    return buildLayer0SizeRepairFeedback({ diagnostics });
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

    const bounds = getLayer0SummaryTokenBounds(settings);
    const sourceRangeLine = buildLayer0SourceRangeLine(metadata);
    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_l0_constraints>\n' +
        `[NARRATIVE] target: about ${bounds.target} tokens; never exceed ${bounds.max} tokens.\n` +
        sourceRangeLine +
        ENGLISH_FIRST_LANGUAGE_RULE_WITH_NEWLINE +
        'Output exactly [NARRATIVE] and [STATE] sections with no preamble or markdown code block.\n' +
        '[NARRATIVE] must be one dense paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags there.\n' +
        LAYER0_DURABILITY_RULES +
        '\n' +
        ANTI_RUN_ON_RULE +
        '\n' +
        '[STATE] must rewrite the complete current snapshot. Omitted facts are removed rather than inherited.\n' +
        '[STATE] must always include current_date_time.\n' +
        'Use temporal format YYYY-MM-DD HH ddd with 24-hour, hour-level precision only, e.g. 2024-12-03 06 Wed; drop minutes instead of preserving them.\n' +
        'Normalize time from raw bracket headers or passage timestamps when present; if no explicit passage time appears, carry forward prior current_date_time.\n' +
        '[STATE] may use only current_date_time, location, characters, dynamics, constraints, hooks, and inventory.\n' +
        `Keep [STATE] near ${STATE_SNAPSHOT_SOFT_TARGET_TOKENS} tokens when complex and never above ${STATE_SNAPSHOT_MAX_TOKENS} tokens; use fewer when simple.\n` +
        STATE_DEDUPLICATION_RULES +
        '\n' +
        '[STATE] must not include static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.\n' +
        'Do NOT write descriptive sentences in the state block. Use concise key: value fragments only. Put the most important facts first.\n' +
        'Treat [STATE] as durable continuity, not an event ledger or scene replay.\n' +
        'Do not preserve clothing, pose, momentary mood/arousal, ordinary props, completed errands, resolved hooks, physiological or sex counters, consumed food/drink, or soiled/used/disposed temporary items.\n' +
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
export function getPromotionSummaryTokenTarget(metadata = {}) {
    const sourceTokens = Number(metadata.memoryTokensBefore);
    if (!Number.isFinite(sourceTokens) || sourceTokens <= 0) {
        return null;
    }
    return Math.max(1, Math.round(sourceTokens * PROMOTION_TARGET_RATIO));
}

/**
 * Compute the hard maximum size for a Layer 1+ promotion.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {number|null}
 */
export function getPromotionSummaryTokenHardMax(metadata = {}) {
    const sourceTokens = Number(metadata.memoryTokensBefore);
    if (!Number.isFinite(sourceTokens) || sourceTokens <= 0) {
        return null;
    }
    return Math.max(1, Math.floor(sourceTokens * PROMOTION_HARD_MAX_RATIO));
}

/**
 * Add Layer 1+ promotion-specific consolidation constraints.
 * @param {string} prompt
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function appendPromotionPromptConstraints(prompt, metadata = {}) {
    const target = getPromotionSummaryTokenTarget(metadata);
    const hardMax = getPromotionSummaryTokenHardMax(metadata);
    const targetLine =
        target === null
            ? 'Target length: make the output significantly shorter than the combined input memories.\n'
            : `Soft target: about ${target} tokens, 40% of the source narratives. Hard maximum: ${hardMax} tokens, 60% of the source narratives.\n`;
    const repairLine = buildPromotionRepairLine(metadata);

    return (
        `${String(prompt || '').trimEnd()}\n\n` +
        '<summaryception_promotion_constraints>\n' +
        targetLine +
        repairLine +
        ENGLISH_FIRST_LANGUAGE_RULE_WITH_NEWLINE +
        'Read the provided source narratives and the separate source-state context.\n' +
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
        PROMOTION_MODERATE_MACRO_RULES +
        '\n' +
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
    const targetTokens = Number(repair.targetTokens);
    const hardMaxTokens = Number(repair.hardMaxTokens ?? repair.requiredMaxTokens);
    const rejected = String(repair.rejectedSummary || '').trim();
    const diagnostics =
        repair.diagnostics ||
        buildRepairDiagnostics({
            scope: 'Layer 1+ promotion',
            totalTokens: outputTokens,
            sections: [
                {
                    id: 'draft',
                    label: '[NARRATIVE]',
                    actualTokens: outputTokens,
                    targetTokens,
                    hardMaxTokens,
                    text: rejected,
                    repairInstruction:
                        'rewrite as macro-level prose only; remove dialogue, scene replay, micro-actions, and transient detail',
                    preservationInstruction:
                        'retain only macro-level durable chronology and continuity',
                },
            ],
            rejectedDraft: rejected,
        });
    const feedback = formatRepairDiagnostics(diagnostics, {
        wrapperTag: 'summaryception_promotion_repair_feedback',
        rejectedSectionTagPrefix: 'rejected_promotion_',
    });

    return (
        'Repair task: rewrite the rejected narrative toward the soft target, not merely below the hard maximum.\n' +
        'Keep only macro-level durable chronology, current position, relationship/state changes, permanent rules, and unresolved hooks.\n' +
        feedback +
        '\n'
    );
}
