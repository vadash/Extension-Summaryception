import { debug } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/state.js';
import {
    STATE_SNAPSHOT_MAX_TOKENS,
    STATE_SNAPSHOT_REPAIR_CEILING_TOKENS,
    STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
} from '../foundation/prompt-constants.js';
import {
    buildLayer0SizeRepairFeedback,
    getLayer0SummaryRepairCeiling,
    getLayer0SummaryTokenBounds,
    isLayer0SizeGuardCall,
} from './layer0-compression.js';
import { buildRepairDiagnostics } from './repair-diagnostics.js';
import { compactStateSnapshotText } from './summarizer-state.js';
import { normalizeStructuralHeaderLines } from './structural-headers.js';
import { countTextTokens } from './token-count.js';

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

    let outputTokens = initialOutputTokens;
    const stateNormalization = await compactStateNearMiss(sections.state, initialStateTokens);
    const normalizedState = stateNormalization.text;
    const stateTokens = stateNormalization.tokens;
    let normalizedText = String(text || '');
    if (stateNormalization.changed) {
        normalizedText = rebuildLayer0Output(sections.narrative, stateNormalization.block);
        outputTokens = await countTextTokens(normalizedText);
    }

    const sourceTokens = getSourceTokenCount(metadata);
    const narrativeRepairCeiling = getLayer0SummaryRepairCeiling(settings);
    const narrativeTooLong = narrativeTokens.count > narrativeRepairCeiling;
    const stateTooLong = stateTokens.count > STATE_SNAPSHOT_MAX_TOKENS;
    const diagnostics = buildRepairDiagnostics({
        scope: 'Layer 0',
        totalTokens: outputTokens.count,
        sections: [
            {
                id: 'narrative',
                label: '[NARRATIVE]',
                actualTokens: narrativeTokens.count,
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
                actualTokens: stateTokens.count,
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

    if (diagnostics.violations.length > 0) {
        return rejectLayer0Size(diagnostics);
    }

    if (narrativeTokens.count > bounds.max && narrativeTokens.count <= narrativeRepairCeiling) {
        debug(
            `Accepted Layer 0 narrative within repair grace: ${narrativeTokens.count} tokens (prompt maximum ${bounds.max}, repair ceiling ${narrativeRepairCeiling})`,
        );
    }

    return stateNormalization.changed
        ? { valid: true, error: null, repairFeedback: '', text: normalizedText }
        : { valid: true, error: null, repairFeedback: '' };
}

async function compactStateNearMiss(stateText, stateTokens) {
    if (
        stateTokens.count <= STATE_SNAPSHOT_MAX_TOKENS ||
        stateTokens.count > STATE_SNAPSHOT_REPAIR_CEILING_TOKENS
    ) {
        return { text: stateText, block: '', tokens: stateTokens, changed: false };
    }

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
        `Accepted Layer 0 state after deterministic compaction: ${String(stateText || '').length} chars -> ${compactedStateBody.length} chars`,
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

function getSourceTokenCount(metadata = {}) {
    const candidates = [
        metadata.sourceTokensBefore,
        metadata.regexStats?.finalTokens,
        metadata.memoryTokensBefore,
    ];
    for (const value of candidates) {
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) {
            return count;
        }
    }
    return 0;
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
 * @returns {{ valid: false, error: Error & { retryable?: boolean }, repairFeedback: string, diagnostics: object }}
 */
function rejectLayer0Size(diagnostics) {
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
    return {
        valid: false,
        error,
        repairFeedback: buildLayer0SizeRepairFeedback({ diagnostics }),
        diagnostics,
    };
}
