import { callTokenCountAsync } from '../foundation/context.js';

const APPROX_TEXT_UNITS_PER_TOKEN = 4;

/**
 * @typedef {object} TokenCount
 * @property {number} count - Token count
 * @property {boolean} estimated - Whether the count came from the fallback estimator
 */

/**
 * Count tokens using SillyTavern's active tokenizer, with a marked fallback.
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
 * Format a TokenCount with '~' when it came from the fallback estimator.
 * @param {TokenCount | null | undefined} tokenCount - Count to format
 * @returns {string}
 */
export function formatTokenCount(tokenCount) {
    if (!tokenCount || !Number.isFinite(tokenCount.count)) {
        return '?';
    }
    return `${tokenCount.estimated ? '~' : ''}${tokenCount.count}`;
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
    return `${estimated ? '~' : ''}${count}`;
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
