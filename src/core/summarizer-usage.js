import { log } from '../foundation/logger.js';
import { countTextTokens, formatTokenValue } from './token-count.js';

/**
 * @typedef {import('./chatutils.js').PassageRegexStats} PassageRegexStats
 */

/**
 * @typedef {object} SummarizerCallMetadata
 * @property {'layer0' | 'promotion' | 'regenerate' | string} [kind] - Call category
 * @property {[number, number]} [sourceRange] - Source chat index range
 * @property {number} [assistantTurnCount] - Assistant turns summarized
 * @property {PassageRegexStats} [regexStats] - Passage regex stats
 * @property {number} [layerIndex] - Source layer for promotion calls
 * @property {number} [mergedSnippetCount] - Snippets merged for promotion calls
 * @property {number} [memoryTokensBefore] - Source memory size before promotion
 * @property {boolean} [memoryTokensBeforeEstimated] - Whether memoryTokensBefore was estimated
 * @property {boolean} [useFallback] - Whether this call is routed through fallback
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
 * @property {SummarizerCallMetadata} [metadata] - Call metadata
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
 * Start collecting usage for a scoped summarization run.
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
 * Run an async function inside a usage aggregation scope.
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
    log(formatCallUsageLine(logEntry));
}

/**
 * Add usage to one run and assign that run's local call number.
 * @param {UsageRun} run - Active run
 * @param {SummarizerUsageInput} usage - Usage input
 * @returns {SummarizerUsageEntry}
 */
function addUsageToRun(run, usage) {
    const entry = {
        ...usage,
        metadata: usage.metadata || {},
        callNumber: run.calls.length + 1,
    };
    run.calls.push(entry);
    return entry;
}

/**
 * Log the max-token call for a completed run.
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

    log(
        `LLM run ${run.label} max call: #${maxCall.callNumber} ` +
            `${describeCall(maxCall.metadata)} total=${formatUsageTokenCount(
                maxCall.totalTokens,
                isTotalEstimated(maxCall),
            )} ` +
            `tokens (prompt=${formatUsageTokenCount(
                maxCall.promptTokens,
                maxCall.promptTokensEstimated,
            )}, ` +
            `completion=${formatUsageTokenCount(
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
 * Build the compact per-call usage log.
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @returns {string}
 */
function formatCallUsageLine(entry) {
    const callNumber = entry.callNumber > 0 ? `#${entry.callNumber} ` : '';
    const stats = formatRegexStats(entry.metadata?.regexStats);
    const memoryStats = formatPromotionMemoryStats(entry);
    const statsParts = [stats, memoryStats].filter(Boolean);
    const statsPart = statsParts.length > 0 ? `${statsParts.join('; ')}; ` : '';
    return (
        `LLM call ${callNumber}${describeCall(entry.metadata)}: ` +
        `${statsPart}tokens prompt=${formatUsageTokenCount(
            entry.promptTokens,
            entry.promptTokensEstimated,
        )} ` +
        `completion=${formatUsageTokenCount(
            entry.completionTokens,
            entry.completionTokensEstimated,
        )} ` +
        `total=${formatUsageTokenCount(entry.totalTokens, isTotalEstimated(entry))}`
    );
}

/**
 * Format memory compression stats for a promotion call log.
 * @param {SummarizerUsageEntry} entry - Usage entry
 * @returns {string}
 */
function formatPromotionMemoryStats(entry) {
    if (entry.metadata?.kind !== 'promotion') {
        return '';
    }
    if (typeof entry.metadata.memoryTokensBefore !== 'number') {
        return '';
    }
    return `memory=${formatUsageTokenCount(
        entry.metadata.memoryTokensBefore,
        entry.metadata.memoryTokensBeforeEstimated,
    )}->${formatUsageTokenCount(entry.completionTokens, entry.completionTokensEstimated)}`;
}

/**
 * Describe a summarizer call from its metadata.
 * @param {SummarizerCallMetadata | undefined} metadata - Call metadata
 * @returns {string}
 */
function describeCall(metadata = {}) {
    if (metadata.kind === 'layer0') {
        const turns = formatCount(metadata.assistantTurnCount, 'assistant turn');
        return `layer0 turns ${formatRange(metadata.sourceRange)} (${turns})`;
    }
    if (metadata.kind === 'promotion') {
        const snippets = formatCount(metadata.mergedSnippetCount, 'snippet');
        return `promotion L${metadata.layerIndex ?? '?'} (${snippets})`;
    }
    if (metadata.kind === 'regenerate') {
        return `regenerate turns ${formatRange(metadata.sourceRange)}`;
    }
    return metadata.kind || 'summarizer';
}

/**
 * Format passage regex stats for a call log.
 * @param {PassageRegexStats | undefined} stats - Passage stats
 * @returns {string}
 */
function formatRegexStats(stats) {
    if (!stats) {
        return '';
    }
    return (
        `regex tokens ${formatTokenValue(stats.rawTokens, stats.rawTokensEstimated)}->` +
        `${formatTokenValue(stats.finalTokens, stats.finalTokensEstimated)}, ` +
        `saved=${formatTokenValue(stats.savedTokens, stats.savedTokensEstimated)} ` +
        `(${formatNumber(stats.savedPercent, 1)}%), ` +
        `changed=${stats.changedMessageCount}`
    );
}

/**
 * Format an optional token count.
 * @param {number | null | undefined} count - Token count
 * @param {boolean} [estimated] - Whether the count came from fallback estimation
 * @returns {string}
 */
function formatUsageTokenCount(count, estimated = false) {
    return formatTokenValue(count, estimated);
}

/**
 * Check whether a total token count includes estimated values.
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
 * Format a number with optional fixed precision.
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

/**
 * Format a chat index range.
 * @param {[number, number] | undefined} range - Source range
 * @returns {string}
 */
function formatRange(range) {
    if (!Array.isArray(range) || range.length < 2) {
        return '?';
    }
    return `${range[0]}-${range[1]}`;
}

/**
 * Format a singular/plural count.
 * @param {number | undefined} count - Count value
 * @param {string} singular - Singular label
 * @returns {string}
 */
function formatCount(count, singular) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return `? ${singular}s`;
    }
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
