/**
 * Shared value primitives: the plain-object guard callers reach for without
 * learning about settings or stores, and the stable-id list normalizer both
 * the store and Snippet validation dedupe through.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Normalize a stable message ID array.
 * @param {unknown} values
 * @returns {string[]}
 */
export function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || value.trim() === '' || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
}
