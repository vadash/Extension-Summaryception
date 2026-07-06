import { getSettings } from '../foundation/state.js';

// ─── Output Cleaning ─────────────────────────────────────────────────

const CHINESE_IDEOGRAPH_REGEX = /\p{Script=Han}/gu;
const VISIBLE_CHARACTER_REGEX = /\S/gu;

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

    const s = getSettings();

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
