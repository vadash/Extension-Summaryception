import { formatTokenValue } from '../core/token-count.js';

/**
 * @typedef {object} ContextBudgetTokenPart
 * @property {string} label - Segment label for budget displays.
 * @property {string} kind - Segment category used for styling and ordering.
 * @property {number} count - Token count for the segment.
 * @property {boolean} estimated - Whether the count came from fallback estimation.
 */

/**
 * @param {number} tokens
 * @returns {string}
 */
export function getContextColorClass(tokens) {
    if (tokens > 48000) {
        return 'sc-ctx-danger';
    }
    if (tokens > 32000) {
        return 'sc-ctx-caution';
    }
    if (tokens > 24000) {
        return 'sc-ctx-warn';
    }
    return 'sc-ctx-safe';
}

/**
 * @param {{ budget: number, verbatim: ContextBudgetTokenPart, layers: ContextBudgetTokenPart[], wrapper?: ContextBudgetTokenPart | null, marker?: { positionTokens: number, label: string } | null }} input
 * @returns {{ budget: number, used: number, overage: number, denominator: number, totalLabel: string, marker: { percent: number, label: string } | null, segments: Array<ContextBudgetTokenPart & { percent: number, small: boolean }> }}
 */
export function buildContextBudgetViewModel({
    budget,
    verbatim,
    layers,
    wrapper = null,
    marker = null,
}) {
    const normalizedBudget = normalizeBudgetCount(budget);
    const parts = [verbatim, ...layers, wrapper].filter(isVisibleBudgetPart);
    const used = parts.reduce((sum, part) => sum + part.count, 0);
    const overage = Math.max(0, used - normalizedBudget);
    const freeCount = Math.max(0, normalizedBudget - used);
    const anyEstimated = parts.some((part) => part.estimated);
    const markerTokens = marker ? normalizeBudgetCount(marker.positionTokens) : 0;
    const denominator = Math.max(normalizedBudget, used, markerTokens, 1);

    const segments = parts.map((part) => buildBudgetSegment(part, denominator));
    if (freeCount > 0) {
        segments.push(
            buildBudgetSegment(
                { label: 'Free Space', kind: 'free', count: freeCount, estimated: false },
                denominator,
            ),
        );
    }

    return {
        budget: normalizedBudget,
        used,
        overage,
        denominator,
        marker: marker
            ? { percent: Math.min(100, (markerTokens / denominator) * 100), label: marker.label }
            : null,
        totalLabel: `${formatBudgetTokenLabel(used, anyEstimated)} / ${formatBudgetTokenLabel(
            normalizedBudget,
            false,
        )}`,
        segments,
    };
}

/**
 * @param {number} count
 * @param {boolean} estimated
 * @returns {string}
 */
export function formatBudgetTokenLabel(count, estimated = false) {
    return formatTokenValue(normalizeBudgetCount(count), estimated);
}

/**
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @param {ReturnType<import('../foundation/state.js').getEffectiveSettings>} s
 * @returns {{ queuedTokens: number, queuedEstimated: boolean, triggerTokens: number, label: string }}
 */
export function buildTriggerGaugeModel(work, s) {
    return {
        queuedTokens: normalizeBudgetCount(work?.queuedTokens ?? 0),
        queuedEstimated: Boolean(work?.queuedEstimated),
        triggerTokens: normalizeBudgetCount(s.queuedTokenBudget),
        label: 'Summarize at Recent + Queued',
    };
}

function buildBudgetSegment(part, denominator) {
    const percent = denominator > 0 ? (part.count / denominator) * 100 : 0;
    return {
        ...part,
        percent,
        small: percent < 8,
    };
}

/**
 * @param {ContextBudgetTokenPart | null | undefined} part
 * @returns {part is ContextBudgetTokenPart}
 */
function isVisibleBudgetPart(part) {
    return Boolean(part && normalizeBudgetCount(part.count) > 0);
}

function normalizeBudgetCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return 0;
    }
    return Math.max(0, Math.ceil(count));
}
