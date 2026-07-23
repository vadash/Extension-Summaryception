/**
 * Model-facing safety-gap ratio. The prompt shows the model numbers that are
 * this fraction of the real validation bound, leaving a ~10% head room so a
 * first attempt that lands near the model-facing number still passes real
 * validation. Real validation ceilings are unchanged; only prompt guidance
 * changes.
 */
export const BUDGET_SAFETY_GAP_RATIO = 0.9;

/**
 * Apply the 10% model-facing safety gap to a real validation bound.
 * @param {number} realBound - True validation bound.
 * @returns {number} Floored model-facing value (`round(realBound * 0.9)`).
 */
export function applySafetyGap(realBound) {
    const value = Number(realBound);
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.round(value * BUDGET_SAFETY_GAP_RATIO);
}
