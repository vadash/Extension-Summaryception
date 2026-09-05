import { debug, warn } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/state.js';
import {
    STATE_SNAPSHOT_MAX_TOKENS,
    STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
} from '../foundation/prompt-constants.js';
import {
    buildLayer0SizeRepairFeedback,
    getLayer0SummaryRepairCeiling,
    getLayer0SummaryTokenBounds,
    getLayer0SummaryTokenTarget,
    isLayer0SizeGuardCall,
} from './layer0-compression.js';
import { buildRepairDiagnostics, buildStructuralRepairFeedback } from './repair-diagnostics.js';
import { compactStateSnapshotText, parseSnippet } from './summarizer-state.js';
import { normalizeStructuralHeaderLines } from './structural-headers.js';
import { countTextTokens } from './token-count.js';
import { getSourceTokenCount } from './token-budget.js';

// ─── Output Cleaning ─────────────────────────────────────────────────

const CHINESE_IDEOGRAPH_REGEX = /\p{Script=Han}/gu;
const VISIBLE_CHARACTER_REGEX = /\S/gu;
const SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD = 500;
const MIN_OUTPUT_TOKENS_FOR_SUBSTANTIAL_SOURCE = 30;
const MIN_OUTPUT_CHARS_FOR_SUBSTANTIAL_SOURCE = 150;
const NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*$/i;
const STATE_HEADER_RE = /^\s*\[STATE\]\s*$/i;

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 * @param {string} raw - The raw summarizer response
 * @param {{ stripStructuralMarkers?: boolean }} [options] - Optional cleanup controls
 * @returns {string} Cleaned text
 */
export function cleanSummarizerOutput(raw, options = {}) {
    let text = raw;

    const s = getEffectiveSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns || []) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    text = normalizeStructuralHeaderLines(text);

    if (options.stripStructuralMarkers) {
        text = text.replace(/^\s*\[NARRATIVE\]\s*$/gim, '');
        text = text.replace(/^\s*\[STATE\]\s*$/gim, '');
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

/**
 * Strip or reject Han-heavy summarizer output when enabled.
 * @param {string} cleanedResult - Output after standard artifact cleanup
 * @param {Partial<ExtensionSettings>} settings - Active settings
 * @returns {{ text: string, error: (Error & { retryable?: boolean }) | null, percent: string | null }}
 */
export function applyChineseOutputPolicy(cleanedResult, settings = {}) {
    if (!settings.stripChineseIdeographs) {
        return { text: cleanedResult, error: null, percent: null };
    }

    const stats = getChineseIdeographStats(cleanedResult);
    if (stats.chineseIdeographs > 0 && stats.ratio > 0.1) {
        const percent = (stats.ratio * 100).toFixed(1);
        const error = /** @type {Error & { retryable?: boolean }} */ (
            new Error(`CN ideograph ratio ${percent}% exceeds 10%`)
        );
        error.retryable = true;
        return { text: '', error, percent };
    }

    return {
        text: cleanWhitespace(stripChineseIdeographs(cleanedResult)),
        error: null,
        percent: null,
    };
}

/**
 * Validate cleaned summarizer output before it can be committed.
 * @param {string} text - Cleaned summarizer output
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {{ valid: true, error: null } | { valid: false, error: Error & { retryable?: boolean } }}
 */
export function validateSummarizerOutputIntegrity(text, metadata = {}) {
    const output = String(text || '').trim();
    if (isLayer0StructuredCall(metadata)) {
        const structuralError = validateLayer0Structure(output);
        if (structuralError) {
            return rejectIntegrity(structuralError);
        }
    }

    const sourceTokens = getSourceTokenCount(metadata);
    if (sourceTokens > SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD && isOutputTooShortForSource(output)) {
        const stats = getApproximateOutputStats(output);
        return rejectIntegrity(
            `output too short for ${sourceTokens} source tokens ` +
                `(${stats.tokens} tokens, ${stats.characters} characters)`,
        );
    }

    return { valid: true, error: null };
}
/**
 * Guard summarizer output before committing; warn once when invalid.
 * @param {string} text - Cleaned summarizer output
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @param {string} [warnPrefix] - Optional prefix for the warning message
 * @returns {boolean}
 */
export function isSummarizerOutputSafe(text, metadata = {}, warnPrefix = '') {
    const integrityResult = validateSummarizerOutputIntegrity(text, metadata);
    if (integrityResult.valid) {
        return true;
    }
    warn(`${warnPrefix}${integrityResult.error.message}`);
    return false;
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
            parseSnippet(`[STATE]\n${String(metadata.sourceState || '')}`).state,
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

    const compactedStateBody = compactedState.replace(/^\s*\[STATE\]\s*/i, '').trim();
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
 * Count Han ideographs and visible characters in text.
 * @param {string} text - Text to inspect
 * @returns {{ chineseIdeographs: number, visibleCharacters: number, ratio: number }}
 */
export function getChineseIdeographStats(text) {
    const source = String(text || '');
    const chineseIdeographs = countMatches(source, CHINESE_IDEOGRAPH_REGEX);
    const visibleCharacters = countMatches(source, VISIBLE_CHARACTER_REGEX);
    return {
        chineseIdeographs,
        visibleCharacters,
        ratio: visibleCharacters > 0 ? chineseIdeographs / visibleCharacters : 0,
    };
}

/**
 * Remove Han ideographs from text.
 * @param {string} text - Text to clean
 * @returns {string}
 */
export function stripChineseIdeographs(text) {
    return String(text || '').replace(CHINESE_IDEOGRAPH_REGEX, '');
}

function cleanWhitespace(text) {
    return String(text || '')
        .replace(/\n{3,}/g, '\n')
        .trim();
}

function countMatches(text, regex) {
    return text.match(regex)?.length || 0;
}

function isLayer0StructuredCall(metadata = {}) {
    return metadata.kind === 'layer0' || metadata.kind === 'regenerate';
}

function validateLayer0Structure(text) {
    const lines = String(text || '').split(/\r?\n/);
    const narrativeIndexes = findHeaderIndexes(lines, NARRATIVE_HEADER_RE);
    const stateIndexes = findHeaderIndexes(lines, STATE_HEADER_RE);
    if (narrativeIndexes.length === 0 || stateIndexes.length === 0) {
        return 'missing required [NARRATIVE] or [STATE] header';
    }
    if (narrativeIndexes.length > 1 || stateIndexes.length > 1) {
        return 'duplicate [NARRATIVE] or [STATE] header';
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

function isOutputTooShortForSource(text) {
    const stats = getApproximateOutputStats(text);
    return (
        stats.tokens < MIN_OUTPUT_TOKENS_FOR_SUBSTANTIAL_SOURCE &&
        stats.characters < MIN_OUTPUT_CHARS_FOR_SUBSTANTIAL_SOURCE
    );
}

function getApproximateOutputStats(text) {
    const source = String(text || '').trim();
    return {
        tokens: source ? source.split(/\s+/).filter(Boolean).length : 0,
        characters: source.length,
    };
}

/**
 * @param {string} reason
 * @returns {{ valid: false, error: Error & { retryable?: boolean } }}
 */
function rejectIntegrity(reason) {
    const error = /** @type {Error & { retryable?: boolean }} */ (
        new Error(`Summarizer response failed integrity validation: ${reason}`)
    );
    error.retryable = true;
    return { valid: false, error };
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
