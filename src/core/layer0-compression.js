import { defaultSettings } from '../foundation/constants.js';
import { debug } from '../foundation/logger.js';
import {
    STATE_SNAPSHOT_MAX_TOKENS,
    STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
} from '../foundation/prompt-constants.js';
import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    countSentences,
    formatRepairDiagnostics,
} from './repair-diagnostics.js';
import {
    LEADING_STATE_HEADER_RE,
    NARRATIVE_HEADER_RE,
    STATE_HEADER_RE,
} from './structural-headers.js';
import {
    insertBeforeTrigger,
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
} from '../foundation/prompt-parts.js';
import { compactStateSnapshotText, parseStateBlock } from './summarizer-state.js';
import {
    buildSizeConstraintsBlock,
    buildSizeTargetLine,
    computeSentenceCap,
    getSourceTokenCount,
    SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD,
    LAYER_HARD_MAX_RATIO,
    LAYER0_REPAIR_RATIO,
} from './token-budget.js';
import { countTextTokens } from './token-count.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MIN_LAYER0_OUTPUT_TOKENS = 50;
const MAX_LAYER0_TARGET_TOKENS = 700;

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
        min: MIN_LAYER0_OUTPUT_TOKENS,
        max: Math.round(target * LAYER_HARD_MAX_RATIO.l0),
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
    return Math.round(getLayer0SummaryTokenTarget(settings) * LAYER0_REPAIR_RATIO);
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
        instructions: [
            'Aim for each section soft target, not merely its hard maximum. Rewrite only the rejected section or sections. Reproduce every preserved section exactly.',
            'Output exactly one [NARRATIVE] section followed by exactly one [STATE] section.',
        ],
    });
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
 * Validate exact Layer 0 output size after structural validation.
 * @param {string} text - Cleaned summarizer output
 * @param {Partial<ExtensionSettings>} settings - Active settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {Promise<{ valid: true, error: null, repairFeedback: '', text?: string } | { valid: false, error: Error & { retryable?: boolean }, repairFeedback: string, diagnostics: object }>}
 */
export async function validateLayer0OutputSize(text, settings, metadata = {}) {
    if (!isLayer0SizeGuardCall(metadata)) {
        return { valid: true, error: null, repairFeedback: '' };
    }

    const sections = extractLayer0Sections(text);
    const bounds = getLayer0SummaryTokenBounds(settings);
    const [initialOutputTokens, narrativeTokens, initialStateTokens] = await Promise.all([
        countTextTokens(text),
        countTextTokens(sections.narrative),
        countTextTokens(sections.state),
    ]);

    const nearMiss = await normalizeLayer0StateNearMiss(
        text,
        sections,
        initialOutputTokens,
        initialStateTokens,
    );

    const narrativeRepairCeiling = getLayer0SummaryRepairCeiling(settings);
    const diagnostics = buildLayer0SizeDiagnostics({
        text,
        bounds,
        narrativeRepairCeiling,
        metadata,
        outputTokens: nearMiss.outputTokens.count,
        sections,
        normalizedState: nearMiss.normalizedState,
        narrativeTokenCount: narrativeTokens.count,
        stateTokenCount: nearMiss.stateTokenCount,
    });

    if (diagnostics.violations.length > 0) {
        // The first-pass deterministic compactor already had its chance on the
        // raw oversized state (above, via compactStateNearMiss). When a state
        // violation still reaches diagnostics here, the compactor could not
        // trim the block under the hard maximum, so an LLM repair is required.
        // Do not add a second compaction pass: compactStateSnapshotText is
        // deterministic, so a retry produces an identical result.

        const sourceStateKeyCount = Object.keys(
            parseStateBlock(String(metadata.sourceState || '')).state,
        ).length;
        return rejectLayer0Size(diagnostics, {
            sourceStateKeyCount,
            targetTokens: getLayer0SummaryTokenTarget(settings),
            layer: 'l0',
        });
    }

    if (narrativeTokens.count > bounds.max && narrativeTokens.count <= narrativeRepairCeiling) {
        debug(
            `Accepted Layer 0 narrative within repair grace: ${narrativeTokens.count} tokens (prompt maximum ${bounds.max}, repair ceiling ${narrativeRepairCeiling})`,
        );
    }

    return nearMiss.changed
        ? { valid: true, error: null, repairFeedback: '', text: nearMiss.normalizedText }
        : { valid: true, error: null, repairFeedback: '' };
}

/**
 * Run the deterministic state compactor on a near-miss oversize state block,
 * rebuilding the draft and recounting tokens when the trim lands under the
 * hard maximum.
 * @param {string} text - Original cleaned draft
 * @param {{ narrative: string, state: string }} sections - Extracted sections
 * @param {import('./token-count.js').TokenCount} initialOutputTokens - Draft token count
 * @param {import('./token-count.js').TokenCount} initialStateTokens - Raw state token count
 * @returns {Promise<{ outputTokens: import('./token-count.js').TokenCount, normalizedText: string, normalizedState: string, stateTokenCount: number, changed: boolean }>}
 */
async function normalizeLayer0StateNearMiss(
    text,
    sections,
    initialOutputTokens,
    initialStateTokens,
) {
    let outputTokens = initialOutputTokens;
    const stateNormalization = await compactStateNearMiss(sections.state, initialStateTokens);
    let normalizedText = String(text || '');
    if (stateNormalization.changed) {
        normalizedText = rebuildLayer0Output(sections.narrative, stateNormalization.block);
        outputTokens = await countTextTokens(normalizedText);
    }
    return {
        outputTokens,
        normalizedText,
        normalizedState: stateNormalization.text,
        stateTokenCount: stateNormalization.tokens.count,
        changed: stateNormalization.changed,
    };
}

/**
 * Build structured size diagnostics for a Layer 0 draft. Section specs mirror
 * the promotion diagnostics shape from buildRepairDiagnostics but keep their
 * own gating: the narrative minimum applies only to substantial sources and
 * hard maximums apply only past the repair ceilings.
 * @param {object} p
 * @param {string} p.text - Original cleaned draft, reported as the rejected draft
 * @param {{ target: number, min: number, max: number }} p.bounds - Layer 0 token bounds
 * @param {number} p.narrativeRepairCeiling - Narrative token ceiling eligible for repair
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata
 * @param {number} p.outputTokens - Total draft tokens after near-miss compaction
 * @param {{ narrative: string, state: string }} p.sections - Extracted sections
 * @param {string} p.normalizedState - State text after near-miss compaction
 * @param {number} p.narrativeTokenCount - Narrative section token count
 * @param {number} p.stateTokenCount - State section token count
 * @returns {object} From buildRepairDiagnostics
 */
function buildLayer0SizeDiagnostics({
    text,
    bounds,
    narrativeRepairCeiling,
    metadata,
    outputTokens,
    sections,
    normalizedState,
    narrativeTokenCount,
    stateTokenCount,
}) {
    const sourceTokens = getSourceTokenCount(metadata);
    const narrativeTooLong = narrativeTokenCount > narrativeRepairCeiling;
    const stateTooLong = stateTokenCount > STATE_SNAPSHOT_MAX_TOKENS;
    return buildRepairDiagnostics({
        scope: 'Layer 0',
        totalTokens: outputTokens,
        sections: [
            {
                id: 'narrative',
                label: '[NARRATIVE]',
                actualTokens: narrativeTokenCount,
                targetTokens: bounds.target,
                hardMaxTokens: narrativeTooLong ? bounds.max : 0,
                minimumTokens: sourceTokens > SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD ? bounds.min : 0,
                text: sections.narrative,
                repairInstruction:
                    'remove scene replay, repeated dialogue, micro-actions, and transient detail while preserving durable chronology',
                preservationInstruction:
                    'keep the accepted event chronology and wording exactly as written',
            },
            {
                id: 'state',
                label: '[STATE]',
                actualTokens: stateTokenCount,
                targetTokens: STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
                hardMaxTokens: stateTooLong ? STATE_SNAPSHOT_MAX_TOKENS : 0,
                text: normalizedState,
                repairInstruction:
                    'rewrite the complete snapshot more abstractly and remove transient facts without turning it into a delta',
                preservationInstruction:
                    'keep the accepted rolling snapshot and key-value wording exactly as written',
            },
        ],
        rejectedDraft: text,
    });
}

async function compactStateNearMiss(stateText, stateTokens) {
    // Only skip when the block already fits; otherwise let the deterministic
    // compactor try. Its own post-trim token check rejects anything that still
    // can't fit, so there is no upper bound to tune here; refusing to try a
    // trim based on the *oversize* magnitude is exactly what forced the
    // wasteful full LLM retries seen in production (a 384/478-token block
    // trims cleanly under the 300-token hard max once the compactor is allowed
    // to run on it).
    if (stateTokens.count <= STATE_SNAPSHOT_MAX_TOKENS) {
        return { text: stateText, block: '', tokens: stateTokens, changed: false };
    }

    const stateChars = String(stateText || '').length;
    const compactedState = compactStateSnapshotText(stateText);
    if (!compactedState) {
        return { text: stateText, block: '', tokens: stateTokens, changed: false };
    }

    const compactedStateBody = compactedState.replace(LEADING_STATE_HEADER_RE, '').trim();
    const compactedTokens = await countTextTokens(compactedStateBody);
    if (compactedTokens.count > STATE_SNAPSHOT_MAX_TOKENS) {
        return { text: stateText, block: '', tokens: stateTokens, changed: false };
    }

    debug(
        `Compacted oversized Layer 0 state pre-retry: ${stateTokens.count} tokens, ${stateChars} chars -> ${compactedStateBody.length} chars (${compactedTokens.count} tokens)`,
    );
    return {
        text: compactedStateBody,
        block: compactedState,
        tokens: compactedTokens,
        changed: true,
    };
}

function rebuildLayer0Output(narrative, stateBlock) {
    return ['[NARRATIVE]', String(narrative || '').trim(), '', String(stateBlock || '').trim()]
        .join('\n')
        .trim();
}

// Deliberately not parseSnippet: this requires BOTH headers before trusting a
// section split, while parseSnippet needs only [STATE] and tolerates a
// missing [NARRATIVE].
function extractLayer0Sections(text) {
    const lines = String(text || '').split(/\r?\n/);
    const narrativeIndex = lines.findIndex((line) => NARRATIVE_HEADER_RE.test(line));
    const stateIndex = lines.findIndex((line) => STATE_HEADER_RE.test(line));
    return {
        narrative:
            narrativeIndex === -1 || stateIndex === -1
                ? ''
                : lines
                      .slice(narrativeIndex + 1, stateIndex)
                      .join('\n')
                      .trim(),
        state:
            stateIndex === -1
                ? ''
                : lines
                      .slice(stateIndex + 1)
                      .join('\n')
                      .trim(),
    };
}

/**
 * Check the structural contract for a Layer 0 draft: exactly one [NARRATIVE]
 * and one [STATE] header, in order, with non-empty section bodies.
 * @param {string} text - Cleaned summarizer output
 * @returns {string} Empty string when valid; a short rejection reason otherwise
 */
export function validateLayer0Structure(text) {
    const lines = String(text || '').split(/\r?\n/);
    const narrativeIndexes = findHeaderIndexes(lines, NARRATIVE_HEADER_RE);
    const stateIndexes = findHeaderIndexes(lines, STATE_HEADER_RE);
    if (narrativeIndexes.length === 0 && stateIndexes.length === 0) {
        return 'missing both [NARRATIVE] and [STATE] headers';
    }
    if (narrativeIndexes.length === 0) {
        return 'missing [NARRATIVE] header';
    }
    if (stateIndexes.length === 0) {
        return 'missing [STATE] header';
    }
    if (narrativeIndexes.length > 1 && stateIndexes.length > 1) {
        return 'duplicate [NARRATIVE] and [STATE] headers';
    }
    if (narrativeIndexes.length > 1) {
        return 'duplicate [NARRATIVE] header';
    }
    if (stateIndexes.length > 1) {
        return 'duplicate [STATE] header';
    }

    const narrativeIndex = narrativeIndexes[0];
    const stateIndex = stateIndexes[0];
    if (narrativeIndex > stateIndex) {
        return '[NARRATIVE] must appear before [STATE]';
    }
    if (!hasNonEmptySection(lines, narrativeIndex + 1, stateIndex)) {
        return '[NARRATIVE] section is empty';
    }
    if (!hasNonEmptySection(lines, stateIndex + 1, lines.length)) {
        return '[STATE] section is empty';
    }
    return '';
}

function findHeaderIndexes(lines, headerRegex) {
    const indexes = [];
    for (let i = 0; i < lines.length; i++) {
        if (headerRegex.test(lines[i])) {
            indexes.push(i);
        }
    }
    return indexes;
}

function hasNonEmptySection(lines, start, end) {
    return lines.slice(start, end).some((line) => line.trim());
}

/**
 * @param {object} diagnostics - From buildRepairDiagnostics
 * @param {{ sourceStateKeyCount?: number, targetTokens?: number, layer?: 'l0' | 'l1' | 'l2' }} [sourceBudget]
 * @returns {{ valid: false, error: Error & { retryable?: boolean }, repairFeedback: string, diagnostics: object }}
 */
function rejectLayer0Size(diagnostics, sourceBudget = {}) {
    const details = diagnostics.violations
        .map((violation) => {
            if (violation.reason === 'below-minimum') {
                return `${violation.label} ${violation.actualTokens} tokens below minimum ${violation.minimumTokens}`;
            }
            return (
                `${violation.label} ${violation.actualTokens} tokens above hard maximum ` +
                `${violation.hardMaxTokens} (target ${violation.targetTokens})`
            );
        })
        .join('; ');
    const error = /** @type {Error & { retryable?: boolean }} */ (
        new Error(`Summarizer response failed L0 section size validation: ${details}`)
    );
    error.retryable = true;
    const tokenFeedback = buildLayer0SizeRepairFeedback({ diagnostics });
    const structuralFeedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
    return {
        valid: false,
        error,
        repairFeedback: structuralFeedback
            ? `${tokenFeedback}\n${structuralFeedback}`
            : tokenFeedback,
        diagnostics,
    };
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
        return appendPromotionPromptConstraints(prompt, settings, metadata);
    }

    const sourceRangeLine = buildLayer0SourceRangeLine(metadata);
    const budgetHint = metadata.budgetHint ? String(metadata.budgetHint).trim() : '';
    const insert = [budgetHint, sourceRangeLine].filter(Boolean).join('\n\n');
    return insertBeforeTrigger(prompt, insert, EXECUTION_TRIGGER_L0);
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
 * Add Layer 1+ promotion-specific consolidation constraints.
 * @param {string} prompt
 * @param {Partial<ExtensionSettings>} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function appendPromotionPromptConstraints(prompt, settings, metadata = {}) {
    const targetTokens = getLayer0SummaryTokenTarget(settings);
    const layerIndex = Number(metadata.layerIndex);
    const sentenceCap = computeSentenceCap(layerIndex >= 1 ? 'l2' : 'l1', targetTokens);
    const withSchemaCap = fillSentenceCapPlaceholders(prompt, sentenceCap);

    const targetLine = buildSizeTargetLine({
        label: '[NARRATIVE]',
        verb: 'merge into',
        cap: sentenceCap,
        unit: 'sentences',
        extra: buildPromotionTargetExtra(metadata),
    });
    const repairLine = buildPromotionRepairLine(metadata, targetTokens);

    const block = buildSizeConstraintsBlock({
        wrapperTag: 'summaryception_promotion_constraints',
        targetLine,
        repairLine,
    });
    return insertBeforeTrigger(withSchemaCap, block, EXECUTION_TRIGGER_PROMO);
}

// Small cardinals for dual-framing the sentence cap in <output_schema>
// (e.g. "AT MOST five (5)"). Falls back to the digit for larger values.
const SENTENCE_CAP_WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
];

/**
 * Replace {{max_sentences}} / {{max_sentences_word}} schema placeholders with
 * the computed cap. No-op when the template omits them (e.g. repair prompt).
 * @param {string} prompt
 * @param {number} sentenceCap
 * @returns {string}
 */
function fillSentenceCapPlaceholders(prompt, sentenceCap) {
    const word = SENTENCE_CAP_WORDS[sentenceCap] || String(sentenceCap);
    return prompt
        .replaceAll('{{max_sentences_word}}', word)
        .replaceAll('{{max_sentences}}', String(sentenceCap));
}

/**
 * Build the trailing clause of the promotion target line: an L1+-specific
 * "compress-harder" reminder for deep-layer folds.
 * @param {object} metadata
 * @returns {string}
 */
function buildPromotionTargetExtra(metadata) {
    return Number(metadata.layerIndex) >= 1
        ? 'This is a deep-layer fold: merge whole scenes into single outcome sentences; do not replay beats.'
        : '';
}

function buildPromotionRepairLine(metadata = {}, sliderTargetTokens) {
    if (!metadata.promotionRepair) {
        return '';
    }

    const repair = metadata.promotionRepair;
    const outputTokens = Number(repair.outputTokens);
    const hardMaxTokens = Number(repair.hardMaxTokens ?? repair.requiredMaxTokens);
    const tooShort = repair.reason === 'too-short';
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
                    targetTokens: Number(repair.targetTokens),
                    hardMaxTokens,
                    minimumTokens: tooShort ? Number(repair.targetTokens) : 0,
                    text: rejected,
                    repairInstruction: tooShort
                        ? 'expand the fold: it over-merged; restore the dropped durable beats'
                        : 'rewrite as macro-level prose only; remove dialogue, scene replay, micro-actions, and transient detail',
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

    if (tooShort) {
        return (
            'Repair task: the rejected narrative over-merged and dropped durable beats. Expand the fold.\n' +
            'Restore the dropped durable events, agreements, position changes, and unresolved hooks while keeping macro-level prose.\n' +
            feedback +
            '\n'
        );
    }

    const layerIndex = Number(metadata.layerIndex);
    const sentenceCap = computeSentenceCap(layerIndex >= 1 ? 'l2' : 'l1', sliderTargetTokens);
    const sentences = countSentences(rejected);
    const overMsg =
        Number.isFinite(outputTokens) &&
        Number.isFinite(hardMaxTokens) &&
        outputTokens > hardMaxTokens &&
        sentences > 0
            ? `Draft contained ${sentences} sentences; the limit is ${sentenceCap}. Delete at least ${Math.max(1, sentences - sentenceCap)} sentences. Output at most ${sentenceCap} sentences total.`
            : '';
    return (
        'Repair task: rewrite the rejected narrative toward the sentence cap.\n' +
        (overMsg ? overMsg + '\n' : '') +
        'Keep only macro-level durable chronology, current position, relationship/state changes, permanent rules, and unresolved hooks.\n' +
        feedback +
        '\n'
    );
}
