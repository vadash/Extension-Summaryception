/**
 * Single source of truth for parsing untyped settings/input values into
 * finite numbers with bounds.
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function coerceFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInteger(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return min;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} step
 * @returns {number}
 */
export function clampToStep(value, min, max, step) {
    const clamped = clampInteger(value, min, max);
    return Math.min(max, Math.max(min, Math.round(clamped / step) * step));
}

/**
 * @param {unknown} value
 * @param {object} options
 * @param {number} options.fallback Value used when input is not a finite number.
 * @param {number} [options.min] Lower bound (defaults to -Infinity).
 * @param {number} [options.max] Upper bound (defaults to Infinity).
 * @param {boolean} [options.round] Round to the nearest integer before clamping.
 * @returns {number}
 */
export function clampNumericSetting(
    value,
    { fallback, min = -Infinity, max = Infinity, round = false },
) {
    let number = coerceFiniteNumber(value, fallback);
    if (round) {
        number = Math.round(number);
    }
    return Math.min(max, Math.max(min, number));
}
