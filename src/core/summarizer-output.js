import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/state.js';
import {
    isLayer0SizeGuardCall,
    validateLayer0OutputSize,
    validateLayer0Structure,
} from './layer0-compression.js';
import { silentAdapter } from './notify.js';
import {
    NARRATIVE_HEADER_LINES_RE,
    normalizeStructuralHeaderLines,
    STATE_HEADER_LINES_RE,
} from './structural-headers.js';
import { getSourceTokenCount, SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD } from './token-budget.js';

// ─── Output Cleaning ─────────────────────────────────────────────────

const CHINESE_IDEOGRAPH_REGEX = /\p{Script=Han}/gu;
const VISIBLE_CHARACTER_REGEX = /\S/gu;
const MIN_OUTPUT_TOKENS_FOR_SUBSTANTIAL_SOURCE = 30;
const MIN_OUTPUT_CHARS_FOR_SUBSTANTIAL_SOURCE = 150;

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 * @param {string} raw - The raw summarizer response
 * @param {{ stripStructuralMarkers?: boolean }} [options] - Optional cleanup controls
 * @returns {string} Cleaned text
 */
function cleanSummarizerOutput(raw, options = {}) {
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
        text = text.replace(NARRATIVE_HEADER_LINES_RE, '');
        text = text.replace(STATE_HEADER_LINES_RE, '');
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
function applyChineseOutputPolicy(cleanedResult, settings = {}) {
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
    if (isLayer0SizeGuardCall(metadata)) {
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
 * Count Han ideographs and visible characters in text.
 * @param {string} text - Text to inspect
 * @returns {{ chineseIdeographs: number, visibleCharacters: number, ratio: number }}
 */
function getChineseIdeographStats(text) {
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
function stripChineseIdeographs(text) {
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

// ─── Response Processing ──────────────────────────────────────────────

/**
 * Clean and validate a raw provider response.
 * @param {string} rawResult - Raw provider output
 * @param {ExtensionSettings} settings - Active settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter for the language-mix rejection; defaults to the silent adapter
 * @returns {Promise<{ status: 'success', text: string, error: null, repairFeedback: '' } | { status: 'empty' | 'cn-rejected' | 'integrity-rejected' | 'size-rejected', text: string, error: Error & { retryable?: boolean }, repairFeedback: string }>} Rejected attempts keep the cleaned LLM output in `text` for the attempt log; only `empty` has none.
 */
export async function processSummarizerResponse(
    rawResult,
    settings,
    metadata = {},
    notify = silentAdapter,
) {
    const cleanedResult = cleanSummarizerOutput((rawResult || '').trim(), {
        stripStructuralMarkers: false,
    });
    const chinesePolicyResult = applyChineseOutputPolicy(cleanedResult, settings);

    if (chinesePolicyResult.error) {
        notifyLanguageMixRejection(chinesePolicyResult.percent, notify);
        return {
            status: 'cn-rejected',
            text: cleanedResult,
            error: chinesePolicyResult.error,
            repairFeedback: '',
        };
    }

    if (!chinesePolicyResult.text) {
        return {
            status: 'empty',
            text: '',
            error: new Error('Empty response from summarizer'),
            repairFeedback: '',
        };
    }

    const integrityResult = validateSummarizerOutputIntegrity(chinesePolicyResult.text, metadata);
    if (!integrityResult.valid) {
        warn(integrityResult.error.message);
        return {
            status: 'integrity-rejected',
            text: chinesePolicyResult.text,
            error: integrityResult.error,
            repairFeedback: '',
        };
    }

    const sizeResult = await validateLayer0OutputSize(chinesePolicyResult.text, settings, metadata);
    if (!sizeResult.valid) {
        warn(sizeResult.error.message);
        return {
            status: 'size-rejected',
            text: chinesePolicyResult.text,
            error: sizeResult.error,
            repairFeedback: sizeResult.repairFeedback,
        };
    }

    return {
        status: 'success',
        text: sizeResult.text || chinesePolicyResult.text,
        error: null,
        repairFeedback: '',
    };
}

/**
 * Emit the structured language-mix event without coupling the output module to
 * UI side effects.
 * @param {string | null} percent
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the response processing
 * @returns {void}
 */
function notifyLanguageMixRejection(percent, notify) {
    const displayPercent = percent || '?';
    warn(
        `Summarizer response rejected: CN ideographs were ${displayPercent}% of visible characters.`,
    );
    notify.transient({
        kind: NOTIFY_EVENTS.LANGUAGE_MIX_RETRY,
        percent: displayPercent,
    });
}
