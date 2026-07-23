import { callTokenCountAsync } from '../foundation/context.js';

/**
 * Chars per token for the plain-text fallback estimator. Single change-point if
 * the estimate ever moves off 1:4. Note: the Layer 0 size-validation gate and
 * the deterministic state compactor are deliberately char-budgeted so they stay
 * synchronized with this ratio regardless of which tokenizer is authoritative.
 */
const APPROX_TEXT_UNITS_PER_TOKEN = 4;
const MESSAGE_TOKEN_CACHE_KEY = 'sc_token_count';

/**
 * @typedef {object} TokenCount
 * @property {number} count - Token count
 * @property {boolean} estimated - Whether the count came from the fallback estimator
 */

/**
 * @typedef {object} MessageTokenStats
 * @property {number} rawTokens - Rendered line tokens before regex scripts
 * @property {number} finalTokens - Rendered line tokens after regex scripts
 * @property {boolean} rawTokensEstimated - Whether rawTokens came from fallback estimation
 * @property {boolean} finalTokensEstimated - Whether finalTokens came from fallback estimation
 */

/**
 * @typedef {object} BudgetStats
 * @property {number} rawTokens - Tokens before regex scripts.
 * @property {number} finalTokens - Tokens after regex scripts.
 * @property {number} savedTokens - Raw tokens minus final tokens.
 * @property {boolean} rawTokensEstimated - Whether raw tokens came from fallback estimation.
 * @property {boolean} finalTokensEstimated - Whether final tokens came from fallback estimation.
 * @property {boolean} savedTokensEstimated - Whether saved tokens include fallback estimation.
 * @property {number} changedMessageCount - Number of messages changed by regex scripts.
 */

/**
 * @typedef {MessageTokenStats & { changed: boolean }} CountedBudgetMessage
 */

/**
 * @typedef {MessageTokenStats & { textLength: number }} MessageTokenCache
 */

/**
 * Create an empty aggregate budget stats object.
 * @returns {BudgetStats}
 */
export function createBudgetStats() {
    return {
        rawTokens: 0,
        finalTokens: 0,
        savedTokens: 0,
        rawTokensEstimated: false,
        finalTokensEstimated: false,
        savedTokensEstimated: false,
        changedMessageCount: 0,
    };
}

/**
 * Add one counted message to aggregate budget stats.
 * @param {BudgetStats} stats
 * @param {CountedBudgetMessage} counted
 * @returns {void}
 */
export function addBudgetStats(stats, counted) {
    stats.rawTokens += counted.rawTokens;
    stats.finalTokens += counted.finalTokens;
    stats.savedTokens = stats.rawTokens - stats.finalTokens;
    stats.rawTokensEstimated ||= counted.rawTokensEstimated;
    stats.finalTokensEstimated ||= counted.finalTokensEstimated;
    stats.savedTokensEstimated = stats.rawTokensEstimated || stats.finalTokensEstimated;
    if (counted.changed) {
        stats.changedMessageCount++;
    }
}

/**
 * Count tokens using SillyTavern's active tokenizer, with a marked fallback.
 * The Layer 0 size-validation gate and deterministic state compactor are
 * char-budgeted so they stay synchronized with `estimateTokenCount`'s 1:4 ratio
 * below; callers that need exact counts still get the live tokenizer here.
 * @param {string} text - Text to count
 * @returns {Promise<TokenCount>}
 */
export async function countTextTokens(text) {
    const normalizedText = String(text ?? '');
    const exactCount = await countWithActiveTokenizer(normalizedText);

    if (exactCount !== null) {
        return {
            count: exactCount,
            estimated: false,
        };
    }

    return {
        count: estimateTokenCount(normalizedText),
        estimated: true,
    };
}

/**
 * Count rendered raw/final message lines, reusing a saved message count while valid.
 * @param {ChatMessage} message - Chat message to cache on
 * @param {string} rawLine - Rendered message line before regex scripts
 * @param {string} finalLine - Rendered message line after regex scripts
 * @returns {Promise<MessageTokenStats>}
 */
export async function countMessageTokens(message, rawLine, finalLine) {
    const textLength = getMessageTokenCacheLength(rawLine, finalLine);
    const cached = readMessageTokenCache(message, textLength);
    if (cached) {
        return cached;
    }

    const counted = await countRenderedLines(rawLine, finalLine);
    writeMessageTokenCache(message, counted, textLength);
    return counted;
}

/**
 * Format a TokenCount with '~' when it came from the fallback estimator.
 * @param {TokenCount | null | undefined} tokenCount - Count to format
 * @returns {string}
 */
export function formatTokenCount(tokenCount) {
    if (!tokenCount || !Number.isFinite(tokenCount.count)) {
        return '?';
    }
    return formatTokenValue(tokenCount.count, tokenCount.estimated);
}

/**
 * Format raw count fields with their estimate flag.
 * @param {number | null | undefined} count - Count value
 * @param {boolean} [estimated] - Whether the value came from the fallback estimator
 * @returns {string}
 */
export function formatTokenValue(count, estimated = false) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return '?';
    }
    return `${estimated ? '~' : ''}${formatCompactTokenCount(count)}`;
}

/**
 * Format token counts compactly for logs and status surfaces.
 * @param {number} count - Token count
 * @returns {string}
 */
export function formatCompactTokenCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return '?';
    }

    const normalized = Math.trunc(count);
    const sign = normalized < 0 ? '-' : '';
    const absolute = Math.abs(normalized);
    if (absolute >= 1000) {
        return `${sign}${Math.floor(absolute / 1000)}k`;
    }
    return `${normalized}`;
}

/**
 * Count rendered raw/final message lines without cache lookup.
 * @param {string} rawLine
 * @param {string} finalLine
 * @returns {Promise<MessageTokenStats>}
 */
async function countRenderedLines(rawLine, finalLine) {
    const normalizedRawLine = String(rawLine ?? '');
    const normalizedFinalLine = String(finalLine ?? '');

    if (normalizedRawLine === normalizedFinalLine) {
        const tokens = await countTextTokens(normalizedRawLine);
        return {
            rawTokens: tokens.count,
            finalTokens: tokens.count,
            rawTokensEstimated: tokens.estimated,
            finalTokensEstimated: tokens.estimated,
        };
    }

    const [rawTokens, finalTokens] = await Promise.all([
        countTextTokens(normalizedRawLine),
        countTextTokens(normalizedFinalLine),
    ]);
    return {
        rawTokens: rawTokens.count,
        finalTokens: finalTokens.count,
        rawTokensEstimated: rawTokens.estimated,
        finalTokensEstimated: finalTokens.estimated,
    };
}

/**
 * Read a normalized message token cache entry.
 * @param {ChatMessage} message
 * @param {number} textLength
 * @returns {MessageTokenStats | null}
 */
function readMessageTokenCache(message, textLength) {
    const extra = /** @type {{ sc_token_count?: unknown }} */ (message?.extra || {});
    return normalizeMessageTokenCache(extra[MESSAGE_TOKEN_CACHE_KEY], textLength);
}

/**
 * Save message token stats with a lightweight source text marker.
 * @param {ChatMessage} message
 * @param {MessageTokenStats} stats
 * @param {number} textLength
 * @returns {void}
 */
function writeMessageTokenCache(message, stats, textLength) {
    if (!message || typeof message !== 'object') {
        return;
    }

    const target = /** @type {{ extra?: unknown }} */ (message);
    if (!target.extra || typeof target.extra !== 'object') {
        target.extra = {};
    }

    /** @type {{ sc_token_count?: MessageTokenCache }} */ (target.extra)[MESSAGE_TOKEN_CACHE_KEY] =
        {
            textLength,
            rawTokens: stats.rawTokens,
            finalTokens: stats.finalTokens,
            rawTokensEstimated: stats.rawTokensEstimated,
            finalTokensEstimated: stats.finalTokensEstimated,
        };
}

/**
 * Normalize a cached token stats object.
 * @param {unknown} cache
 * @param {number} textLength
 * @returns {MessageTokenStats | null}
 */
function normalizeMessageTokenCache(cache, textLength) {
    if (!cache || typeof cache !== 'object') {
        return null;
    }

    const record =
        /** @type {{ textLength?: unknown, rawTokens?: unknown, finalTokens?: unknown, rawTokensEstimated?: unknown, finalTokensEstimated?: unknown }} */ (
            cache
        );
    if (record.textLength !== textLength) {
        return null;
    }

    const rawTokens = normalizeCachedTokenCount(record.rawTokens);
    const finalTokens = normalizeCachedTokenCount(record.finalTokens);

    if (rawTokens === null || finalTokens === null) {
        return null;
    }

    return {
        rawTokens,
        finalTokens,
        rawTokensEstimated: record.rawTokensEstimated === true,
        finalTokensEstimated: record.finalTokensEstimated === true,
    };
}

/**
 * Get the rendered text length marker for a token cache entry.
 * @param {string} rawLine
 * @param {string} finalLine
 * @returns {number}
 */
function getMessageTokenCacheLength(rawLine, finalLine) {
    return String(rawLine ?? '').length + String(finalLine ?? '').length;
}

/**
 * Normalize a cached token count field.
 * @param {unknown} count
 * @returns {number | null}
 */
function normalizeCachedTokenCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return null;
    }
    return Math.max(0, Math.ceil(count));
}

/**
 * Count tokens with the active SillyTavern tokenizer.
 * @param {string} text - Text to count
 * @returns {Promise<number | null>}
 */
async function countWithActiveTokenizer(text) {
    try {
        const count = await callTokenCountAsync(text);
        return normalizeTokenCount(count);
    } catch (_e) {
        return null;
    }
}

/**
 * Provide a stable fallback when the runtime tokenizer is unavailable.
 * @param {string} text - Text to estimate
 * @returns {number}
 */
function estimateTokenCount(text) {
    if (!text) {
        return 0;
    }
    return Math.max(1, Math.ceil(text.length / APPROX_TEXT_UNITS_PER_TOKEN));
}

/**
 * Normalize tokenizer output to a non-negative integer.
 * @param {unknown} count - Token count returned by SillyTavern
 * @returns {number | null}
 */
function normalizeTokenCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return null;
    }
    return Math.max(0, Math.ceil(count));
}
