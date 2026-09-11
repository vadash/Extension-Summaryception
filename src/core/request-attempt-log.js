import { LOG_PREFIX } from '../foundation/constants.js';
import {
    isPromptInputLogEnabled,
    isPromptLogEnabled,
    isPromptOutputLogEnabled,
    serializeError,
} from '../foundation/logger.js';
import { formatPromotionLabel, formatRange } from './summarizer-usage.js';

/**
 * Create the mutable log state tracked across one attempt.
 * @returns {{ status: string, cleanedResult: string, error: Error | null }}
 */
export function createAttemptLogState() {
    return {
        status: 'failed',
        cleanedResult: '',
        error: null,
    };
}

/**
 * Record an attempt outcome into the transaction log state.
 * @param {{ status: string, cleanedResult: string, error: Error | null }} logState - Mutable log state
 * @param {{ success: boolean, result?: string, cleanedResult?: string, aborted?: boolean, failureStatus?: string, error: Error }} result - Attempt outcome
 * @returns {void}
 */
export function updateAttemptLogState(logState, result) {
    logState.status = getAttemptLogStatus(result);
    logState.cleanedResult = result.cleanedResult || result.result || '';
    logState.error = result.success ? null : result.error;
}

function getAttemptLogStatus(result) {
    if (result.success) {
        return 'success';
    }
    if (result.aborted) {
        return 'aborted';
    }
    return result.failureStatus || 'failed';
}

/**
 * Describe a summarizer request for prompt logs.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
export function describePromptLogCall(metadata = {}) {
    if (metadata.kind === 'layer0') {
        return `L0 turns ${formatRange(metadata.sourceRange)}`;
    }
    if (metadata.kind === 'promotion') {
        return `promotion ${formatPromotionLabel(metadata, '->')}`;
    }
    if (metadata.kind === 'regenerate') {
        return `regenerate turns ${formatRange(metadata.sourceRange)}`;
    }
    return metadata.kind || 'summarizer';
}

/**
 * Log a full prompt/response transaction for one LLM attempt.
 * @param {object} p
 * @param {string} p.label - Human-readable call label
 * @param {string} p.routeLabel - Connection route label
 * @param {number} p.attempt - Zero-based attempt number
 * @param {string} p.status - Attempt status
 * @param {number} p.durationMs - Attempt duration
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - User prompt sent to the summarizer
 * @param {string} p.cleanedResult - Cleaned summary text
 * @param {Error | null} p.error - Attempt error
 * @returns {void}
 */
export function logLlmAttemptTransaction({
    label,
    routeLabel,
    attempt,
    status,
    durationMs,
    systemPrompt,
    prompt,
    cleanedResult,
    error: attemptError,
}) {
    if (!isPromptLogEnabled()) {
        return;
    }

    const inputLogEnabled = isPromptInputLogEnabled();
    const outputLogEnabled = isPromptOutputLogEnabled();
    const title =
        `${LOG_PREFIX} [LLM] ${label} - ${status.toUpperCase()} ` +
        `(${(durationMs / 1000).toFixed(1)}s, ${routeLabel} attempt ${attempt + 1})`;

    console.groupCollapsed(title);
    try {
        if (inputLogEnabled) {
            console.log(
                JSON.stringify(
                    buildLlmInputLog({
                        label,
                        routeLabel,
                        attempt,
                        systemPrompt,
                        prompt,
                    }),
                    null,
                    2,
                ),
            );
        }
        if (outputLogEnabled) {
            console.log(
                JSON.stringify(
                    buildLlmOutputLog({
                        label,
                        routeLabel,
                        attempt,
                        status,
                        cleanedResult,
                        attemptError,
                    }),
                    null,
                    2,
                ),
            );
        }
    } finally {
        console.groupEnd();
    }
}

/**
 * Build a copyable prompt-input log payload.
 * @param {object} p
 * @param {string} p.label
 * @param {string} p.routeLabel
 * @param {number} p.attempt
 * @param {string} p.systemPrompt
 * @param {string} p.prompt
 * @returns {object}
 */
function buildLlmInputLog({ label, routeLabel, attempt, systemPrompt, prompt }) {
    return {
        type: 'summaryception.llm.input.v1',
        label,
        route: routeLabel,
        attempt: attempt + 1,
        messages: [
            { role: 'system', content: systemPrompt || '' },
            { role: 'user', content: prompt || '' },
        ],
    };
}

/**
 * Build a copyable prompt-output log payload.
 * @param {object} p
 * @param {string} p.label
 * @param {string} p.routeLabel
 * @param {number} p.attempt
 * @param {string} p.status
 * @param {string} p.cleanedResult
 * @param {Error | null} p.attemptError
 * @returns {object}
 */
function buildLlmOutputLog({ label, routeLabel, attempt, status, cleanedResult, attemptError }) {
    return {
        type: 'summaryception.llm.output.v1',
        label,
        route: routeLabel,
        attempt: attempt + 1,
        status,
        cleanedSummary: cleanedResult || '',
        error: serializeAttemptError(attemptError),
    };
}

/**
 * Serialize an attempt error into JSON-safe details.
 * @param {Error | null} error
 * @returns {object|null}
 */
function serializeAttemptError(error) {
    return error ? serializeError(error) : null;
}
