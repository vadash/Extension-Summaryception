import { debug } from '../foundation/logger.js';
import { countTextTokens, formatTokenValue } from './token-count.js';

// Usage recording and token-range formatting live here only. The per-call
// human label is resolved once into the CallProfile (src/core/call-profile.js);
// do not re-derive label switches per caller.
/**
 * @typedef {import('./chatutils.js').PassageRegexStats} PassageRegexStats
 */

/**
 * Resolver input for one summarizer call: the call category plus the
 * provenance the dispatch constructors build. Downstream, the request path
 * consumes the resolved CallProfile (src/core/call-profile.js) and never
 * reads `kind`.
 * @typedef {object} SummarizerCallMetadata
 * @property {'layer0' | 'promotion' | 'regenerate' | 'auditor' | string} [kind] - Call category
 * @property {[number, number]} [sourceRange] - Source chat index range
 * @property {PassageRegexStats} [regexStats] - Passage regex stats
 * @property {number} [sourceTokensBefore] - Source text size before summarization
 * @property {boolean} [sourceTokensBeforeEstimated] - Whether sourceTokensBefore was estimated
 * @property {number} [layerIndex] - Source layer for promotion calls
 * @property {number} [mergedSnippetCount] - Snippets merged for promotion calls
 * @property {number} [memoryTokensBefore] - Source memory size before promotion
 * @property {boolean} [memoryTokensBeforeEstimated] - Whether memoryTokensBefore was estimated
 * @property {number} [overflowLayerIndex] - Layer that exceeded promotion limits
 * @property {number} [overflowMemoryCount] - Memory count in the overflowing layer
 * @property {number} [overflowMemoryLimit] - Configured memory count limit for the layer
 * @property {number} [overflowTokens] - Token count in the overflowing layer
 * @property {number} [overflowTokenQuota] - Token quota for the overflowing layer
 * @property {{ reason?: string, outputTokens?: number, targetTokens?: number, hardMaxTokens?: number, requiredMaxTokens?: number, sourceTokens?: number, rejectedSummary?: string, diagnostics?: object }} [promotionRepair] - Promotion repair feedback of this dispatch
 */

/**
 * @typedef {object} SummarizerTokenUsage
 * @property {number | null} promptTokens - Estimated prompt tokens
 * @property {number | null} completionTokens - Estimated completion tokens
 * @property {number | null} totalTokens - Estimated total tokens
 * @property {boolean} promptTokensEstimated - Whether promptTokens came from fallback estimation
 * @property {boolean} completionTokensEstimated - Whether completionTokens came from fallback estimation
 * @property {boolean} totalTokensEstimated - Whether totalTokens includes fallback estimation
 */

/**
 * @typedef {object} SummarizerUsageInput
 * @property {import('./call-profile.js').CallProfile} profile - Resolved call profile of this call
 * @property {number | null} promptTokens - Estimated prompt tokens
 * @property {number | null} completionTokens - Estimated completion tokens
 * @property {number | null} totalTokens - Estimated total tokens
 * @property {boolean} [promptTokensEstimated] - Whether promptTokens came from fallback estimation
 * @property {boolean} [completionTokensEstimated] - Whether completionTokens came from fallback estimation
 * @property {boolean} [totalTokensEstimated] - Whether totalTokens includes fallback estimation
 */

/**
 * @typedef {SummarizerUsageInput & { callNumber: number }} SummarizerUsageEntry
 */

/**
 * @typedef {object} UsageRun
 * @property {string} label - Human-readable run label
 * @property {SummarizerUsageEntry[]} calls - LLM calls recorded in the run
 * @property {UsageRun | null} parent - Parent run when scopes are nested
 * @property {boolean} ended - Whether the run has ended
 */

/** @type {UsageRun | null} */
let activeRun = null;

/**
 * @param {string} label - Human-readable run label
 * @returns {UsageRun}
 */
export function beginUsageRun(label) {
    const run = {
        label,
        calls: [],
        parent: activeRun,
        ended: false,
    };
    activeRun = run;
    return run;
}

/**
 * Finish a usage run and log the largest single LLM call if any were recorded.
 * @param {UsageRun} run - Run object returned by beginUsageRun
 * @returns {void}
 */
export function endUsageRun(run) {
    if (!run || run.ended) {
        return;
    }

    run.ended = true;
    logRunMax(run);

    if (activeRun === run) {
        activeRun = run.parent;
        return;
    }

    detachEndedRun(run);
}

/**
 * @template T
 * @param {string} label - Human-readable run label
 * @param {() => Promise<T>} callback - Work to run
 * @returns {Promise<T>}
 */
export async function withUsageRun(label, callback) {
    const run = beginUsageRun(label);
    try {
        return await callback();
    } finally {
        endUsageRun(run);
    }
}

/**
 * Estimate prompt and completion tokens with SillyTavern's active tokenizer.
 * @param {string} systemPrompt - System prompt sent to the summarizer
 * @param {string} userPrompt - Fully rendered user prompt sent to the summarizer
 * @param {string} completionText - Cleaned summarizer response
 * @returns {Promise<SummarizerTokenUsage>}
 */
export async function estimateSummarizerUsage(systemPrompt, userPrompt, completionText) {
    const [promptTokenCount, completionTokenCount] = await Promise.all([
        countTextTokens(`${systemPrompt || ''}\n${userPrompt || ''}`),
        countTextTokens(completionText || ''),
    ]);
    const totalTokens = promptTokenCount.count + completionTokenCount.count;
    const totalTokensEstimated = promptTokenCount.estimated || completionTokenCount.estimated;

    return {
        promptTokens: promptTokenCount.count,
        completionTokens: completionTokenCount.count,
        totalTokens,
        promptTokensEstimated: promptTokenCount.estimated,
        completionTokensEstimated: completionTokenCount.estimated,
        totalTokensEstimated,
    };
}

/**
 * Record one successful LLM call and emit its compact debug log line.
 * @param {SummarizerUsageInput} usage - Estimated usage and call metadata
 * @returns {void}
 */
export function recordSummarizerUsage(usage) {
    /** @type {SummarizerUsageEntry | null} */
    let logEntry = null;

    for (let run = activeRun; run; run = run.parent) {
        const entry = addUsageToRun(run, usage);
        logEntry ||= entry;
    }

    logEntry ||= { ...usage, callNumber: 0 };
    debug(formatCallUsageLine(logEntry));
}

/**
 * @param {UsageRun} run - Active run
 * @param {SummarizerUsageInput} usage - Usage input
 * @returns {SummarizerUsageEntry}
 */
function addUsageToRun(run, usage) {
    const entry = {
        ...usage,
        callNumber: run.calls.length + 1,
    };
    run.calls.push(entry);
    return entry;
}

/**
 * @param {UsageRun} run - Completed run
 * @returns {void}
 */
function logRunMax(run) {
    /** @type {SummarizerUsageEntry | null} */
    let maxCall = null;

    for (const call of run.calls) {
        if (call.totalTokens === null) {
            continue;
        }
        if (!maxCall || call.totalTokens > (maxCall.totalTokens ?? -1)) {
            maxCall = call;
        }
    }

    if (!maxCall) {
        return;
    }

    debug(
        `LLM run ${run.label} max call: #${maxCall.callNumber} ` +
            `${maxCall.profile.policy.label} total=${formatTokenValue(
                maxCall.totalTokens,
                isTotalEstimated(maxCall),
            )} ` +
            `tokens (prompt=${formatTokenValue(
                maxCall.promptTokens,
                maxCall.promptTokensEstimated,
            )}, ` +
            `completion=${formatTokenValue(
                maxCall.completionTokens,
                maxCall.completionTokensEstimated,
            )})`,
    );
}

/**
 * Remove an out-of-order completed run from the active parent chain.
 * @param {UsageRun} run - Completed run
 * @returns {void}
 */
function detachEndedRun(run) {
    for (let cursor = activeRun; cursor?.parent; cursor = cursor.parent) {
        if (cursor.parent === run) {
            cursor.parent = run.parent;
            return;
        }
    }
}

/**
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @returns {string}
 */
function formatCallUsageLine(entry) {
    const callNumber = entry.callNumber > 0 ? `#${entry.callNumber} ` : '';
    const inputTokens = getInputTokenCount(entry);
    const promptTokens = getPromptOverheadTokenCount(entry, inputTokens);
    const provenance = entry.profile.provenance;
    const regexStats = formatRegexStats(provenance);
    const overflowStats = formatPromotionOverflowStats(provenance);
    const memoryStats = formatPromotionMemoryStats(entry);
    const statsParts = [regexStats, overflowStats, memoryStats].filter(Boolean);
    const statsPart = statsParts.length > 0 ? `; ${statsParts.join('; ')}` : '';
    return (
        `LLM call ${callNumber}${entry.profile.policy.label}: ` +
        `input ${formatTokenValue(inputTokens.count, inputTokens.estimated)}, ` +
        `prompt ${formatTokenValue(promptTokens.count, promptTokens.estimated)}, ` +
        `output ${formatTokenValue(
            entry.completionTokens,
            entry.completionTokensEstimated,
        )}${statsPart}`
    );
}

/**
 * Get source text tokens for the LLM call. Provenance decides: promotion
 * calls carry memory tokens, direct calls carry the passage regex stats.
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @returns {{ count: number | null | undefined, estimated: boolean }}
 */
function getInputTokenCount(entry) {
    const provenance = entry.profile.provenance;
    if (typeof provenance.memoryTokensBefore === 'number') {
        return {
            count: provenance.memoryTokensBefore,
            estimated: Boolean(provenance.memoryTokensBeforeEstimated),
        };
    }

    if (provenance.regexStats) {
        return {
            count: provenance.regexStats.finalTokens,
            estimated: Boolean(provenance.regexStats.finalTokensEstimated),
        };
    }

    return {
        count: null,
        estimated: false,
    };
}

/**
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @param {{ count: number | null | undefined, estimated: boolean }} inputTokens - Source tokens
 * @returns {{ count: number | null | undefined, estimated: boolean }}
 */
function getPromptOverheadTokenCount(entry, inputTokens) {
    if (typeof entry.promptTokens !== 'number' || !Number.isFinite(entry.promptTokens)) {
        return {
            count: entry.promptTokens,
            estimated: Boolean(entry.promptTokensEstimated),
        };
    }

    if (typeof inputTokens.count !== 'number' || !Number.isFinite(inputTokens.count)) {
        return {
            count: entry.promptTokens,
            estimated: Boolean(entry.promptTokensEstimated),
        };
    }

    return {
        count: Math.max(0, entry.promptTokens - inputTokens.count),
        estimated: Boolean(entry.promptTokensEstimated || inputTokens.estimated),
    };
}

/**
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @returns {string}
 */
function formatPromotionMemoryStats(entry) {
    const memoryTokensBefore = entry.profile.provenance.memoryTokensBefore;
    if (typeof memoryTokensBefore !== 'number') {
        return '';
    }
    const savedPercent = getSavedPercent(memoryTokensBefore, entry.completionTokens);
    if (savedPercent === null) {
        return '';
    }
    return `saved ${savedPercent}%`;
}

/**
 * Overflow stats read only the provenance fields promotion dispatches set.
 * @param {import('./call-profile.js').CallProvenance} provenance
 * @returns {string}
 */
function formatPromotionOverflowStats(provenance = {}) {
    if (typeof provenance.overflowLayerIndex !== 'number') {
        return '';
    }

    return (
        `overflow L${provenance.overflowLayerIndex} ` +
        `${formatOverflowValue(provenance.overflowMemoryCount)}/${formatOverflowValue(
            provenance.overflowMemoryLimit,
        )} memories, ` +
        `${formatTokenValue(provenance.overflowTokens)}/${formatTokenValue(
            provenance.overflowTokenQuota,
        )} tokens`
    );
}

/**
 * @param {number | undefined} before - Source token count
 * @param {number | null | undefined} after - Output token count
 * @returns {number | null}
 */
function getSavedPercent(before, after) {
    if (
        typeof before !== 'number' ||
        !Number.isFinite(before) ||
        before <= 0 ||
        typeof after !== 'number' ||
        !Number.isFinite(after)
    ) {
        return null;
    }
    return Math.round(((before - after) / before) * 100);
}

/**
 * @param {number | undefined} value - Count value
 * @returns {string}
 */
function formatOverflowValue(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '?';
    }
    return String(value);
}

/**
 * Regex stats read only the provenance field direct calls set.
 * @param {import('./call-profile.js').CallProvenance} provenance
 * @returns {string}
 */
function formatRegexStats(provenance = {}) {
    if (!provenance.regexStats) {
        return '';
    }
    return `regex saved ${formatNumber(provenance.regexStats.savedPercent, 0)}%`;
}

/**
 * @param {SummarizerUsageInput} entry - Usage entry
 * @returns {boolean}
 */
function isTotalEstimated(entry) {
    return Boolean(
        entry.totalTokensEstimated ||
        entry.promptTokensEstimated ||
        entry.completionTokensEstimated,
    );
}

/**
 * @param {number} value - Number to format
 * @param {number} [digits] - Decimal digits
 * @returns {string}
 */
function formatNumber(value, digits) {
    if (!Number.isFinite(value)) {
        return '?';
    }
    return typeof digits === 'number' ? value.toFixed(digits) : String(value);
}
