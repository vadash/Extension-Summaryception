import { TOAST_TITLE } from '../foundation/constants.js';
import { debug, error as logError, info, trace } from '../foundation/logger.js';
import { RETRY_CONFIG } from '../foundation/retry.js';
import { resolveFallbackSummarizerConnectionSettings } from './connectionutil.js';
import {
    computeAttemptTimeoutMs,
    getPrimaryHealthBucket,
    getRetryStopReason,
    shouldSwitchToRepairPrompt,
} from './request-retry-policy.js';
import {
    appendRepairFeedback,
    classifyAttemptError,
    notifyRetryAndWait,
    notifyRouteCycleFailedAndWait,
    runSingleAttempt,
} from './request-attempt.js';
import {
    createAttemptLogState,
    describePromptLogCall,
    logLlmAttemptTransaction,
    updateAttemptLogState,
} from './request-attempt-log.js';

function buildRouteCycleResult(result) {
    return { status: /** @type {'done'} */ ('done'), result };
}

function shouldTryFallbackRoute(primary, fallbackSettings) {
    return fallbackSettings && (primary.retryable || primary.hardFailover);
}

function logPrimaryProbe(healthBucket, maxRetries) {
    if (maxRetries !== 0) {
        return;
    }

    debug(
        `Primary summarizer previously exhausted retries for ${healthBucket}; ` +
            'probing once before fallback.',
    );
}

function logFallbackRoute(primary, fallbackSettings) {
    info(
        `Primary summarizer failed${primary.hardFailover ? ' (hard network failure)' : ' after retryable errors'}; trying fallback ` +
            `(${fallbackSettings.connectionSource}).`,
    );
}

/**
 * Run summarizer provider requests with retry and fallback routing.
 */
export class RequestRunner {
    constructor() {
        this.primaryRetryExhaustedBuckets = new Set();
    }

    /**
     * Run retry attempts until success, abort, non-retryable error, or exhaustion.
     * @param {object} p
     * @param {ExtensionSettings} p.settings - Settings
     * @param {string} p.systemPrompt - System prompt sent to the summarizer
     * @param {string} p.prompt - Fully substituted user prompt
     * @param {string} p.repairPrompt - Fully substituted Layer 0 repair prompt
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
     * @returns {Promise<string>} Summary text, or '' on failure
     */
    async run({ settings, systemPrompt, prompt, repairPrompt, signal, metadata }) {
        // Shared, read-only context for every route cycle and attempt of this request.
        const series = {
            settings,
            systemPrompt,
            prompt,
            repairPrompt,
            signal,
            metadata,
            healthBucket: getPrimaryHealthBucket(metadata),
            fallbackSettings: resolveFallbackSummarizerConnectionSettings(settings, metadata),
        };

        while (true) {
            if (series.signal.aborted) {
                return abortWithToast();
            }

            const cycle = await this.runRouteCycle(series);

            if (cycle.status === 'retry') {
                continue;
            }

            return cycle.result;
        }
    }

    async runRouteCycle(series) {
        const primary = await this.runPrimaryAttemptSeries(series);

        const resolvedPrimary = this.resolvePrimaryRouteResult(primary, series.healthBucket);
        if (resolvedPrimary) {
            return resolvedPrimary;
        }

        if (shouldTryFallbackRoute(primary, series.fallbackSettings)) {
            return await this.runFallbackRouteCycle(series, primary);
        }

        if (!primary.retryable) {
            return buildRouteCycleResult(
                failSummarization(primary.error, {
                    retriesExhausted: false,
                }),
            );
        }

        this.primaryRetryExhaustedBuckets.delete(series.healthBucket);
        return buildRouteCycleResult(failSummarization(primary.error));
    }

    async runPrimaryAttemptSeries(series) {
        const maxRetries =
            series.fallbackSettings && this.primaryRetryExhaustedBuckets.has(series.healthBucket)
                ? 0
                : RETRY_CONFIG.maxRetries;

        logPrimaryProbe(series.healthBucket, maxRetries);
        return await this.runAttemptSeries(series, {
            routeLabel: 'primary',
            maxRetries,
            metadata: series.metadata,
        });
    }

    resolvePrimaryRouteResult(primary, healthBucket) {
        if (primary.status === 'success') {
            this.primaryRetryExhaustedBuckets.delete(healthBucket);
            return buildRouteCycleResult(primary.result);
        }
        if (primary.status === 'aborted') {
            return buildRouteCycleResult(abortWithToast());
        }
        if (!primary.retryable && !primary.hardFailover) {
            return buildRouteCycleResult(
                failSummarization(primary.error, {
                    retriesExhausted: false,
                }),
            );
        }

        if (primary.retriesExhausted) {
            this.primaryRetryExhaustedBuckets.add(healthBucket);
        }
        return null;
    }

    async runFallbackRouteCycle(series, primary) {
        logFallbackRoute(primary, series.fallbackSettings);
        const fallback = await this.runAttemptSeries(series, {
            routeLabel: 'fallback',
            maxRetries: RETRY_CONFIG.maxRetries,
            metadata: { ...series.metadata, useFallback: true },
        });

        if (fallback.status === 'success') {
            return buildRouteCycleResult(fallback.result);
        }
        if (fallback.status === 'aborted') {
            return buildRouteCycleResult(abortWithToast());
        }

        await notifyRouteCycleFailedAndWait({
            healthBucket: series.healthBucket,
            signal: series.signal,
        });
        this.primaryRetryExhaustedBuckets.delete(series.healthBucket);
        return { status: /** @type {'retry'} */ ('retry'), result: '' };
    }

    /**
     * Run retry attempts for one resolved connection route.
     * @param {object} series - Shared request context built by run()
     * @param {object} attemptState - Per-route state for this attempt series
     * @param {string} attemptState.routeLabel - Human-readable route label for trace logs
     * @param {number} attemptState.maxRetries - Maximum retry count for this route
     * @param {import('./summarizer-usage.js').SummarizerCallMetadata} attemptState.metadata - Route metadata
     * @returns {Promise<{ status: 'success', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false } | { status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean } | { status: 'aborted', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false }>}
     */
    async runAttemptSeries(series, attemptState) {
        const { maxRetries } = attemptState;
        /** @type {Error & { status?: number, response?: { status?: number } }} */
        let lastError = new Error('no error');
        let useRepairPrompt = false;
        let repairFeedback = '';

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (series.signal.aborted) {
                return buildSeriesAbortResult(lastError);
            }

            const attemptResult = await this.executePreparedAttempt(series, {
                ...attemptState,
                attempt,
                useRepairPrompt,
                repairFeedback,
            });

            if (attemptResult.success) {
                return buildSeriesSuccessResult(attemptResult);
            }

            lastError = attemptResult.error;

            if (attemptResult.aborted) {
                return buildSeriesAbortResult(lastError);
            }

            const shouldUseRepairPrompt = shouldSwitchToRepairPrompt({
                attemptResult,
                attempt,
                maxRetries,
                repairPrompt: series.repairPrompt,
            });
            const stopReason = getRetryStopReason(attemptResult, attempt, maxRetries);
            if (stopReason) {
                logRetryStopReason(stopReason, maxRetries);
                return buildSeriesFailureResult({
                    error: lastError,
                    retryable: attemptResult.shouldRetry,
                    retriesExhausted: attemptResult.shouldRetry && attempt >= maxRetries,
                    hardFailover: attemptResult.hardFailover,
                });
            }

            if (shouldUseRepairPrompt) {
                useRepairPrompt = true;
                repairFeedback = attemptResult.repairFeedback || '';
            }

            await notifyRetryAndWait(lastError, attempt, series.signal, maxRetries);
        }

        return buildSeriesFailureResult({
            error: lastError,
            retryable: true,
            retriesExhausted: true,
            hardFailover: false,
        });
    }

    async executePreparedAttempt(series, attemptState) {
        const promptContext = getAttemptPromptContext({
            series,
            useRepairPrompt: attemptState.useRepairPrompt,
            repairFeedback: attemptState.repairFeedback,
        });
        return await this.executeAttempt(series, {
            ...attemptState,
            prompt: promptContext.prompt,
            metadata: promptContext.metadata,
            timeoutMs: computeAttemptTimeoutMs(
                attemptState.metadata,
                attemptState.attempt,
                series.settings,
            ),
        });
    }

    /**
     * Run a single summarizer attempt and classify the outcome.
     * @param {object} series - Shared request context built by run()
     * @param {object} attemptState - Per-attempt state prepared by executePreparedAttempt
     * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean, failureStatus?: string, repairFeedback?: string }>}
     */
    async executeAttempt(series, attemptState) {
        const { prompt, attempt, metadata, routeLabel, maxRetries, timeoutMs } = attemptState;
        trace(`  ${routeLabel} attempt ${attempt} starting...`);
        const startedAt = Date.now();
        const logState = createAttemptLogState();

        try {
            const result = await runSingleAttempt({
                settings: series.settings,
                systemPrompt: series.systemPrompt,
                prompt,
                signal: series.signal,
                attempt,
                metadata,
                routeLabel,
                maxRetries,
                timeoutMs,
            });
            updateAttemptLogState(logState, result);
            return result;
        } catch (err) {
            const result = classifyAttemptError(err, series.signal);
            updateAttemptLogState(logState, result);
            return result;
        } finally {
            logLlmAttemptTransaction({
                label: describePromptLogCall(metadata),
                routeLabel,
                attempt,
                status: logState.status,
                durationMs: Date.now() - startedAt,
                systemPrompt: series.systemPrompt,
                prompt,
                cleanedResult: logState.cleanedResult,
                error: logState.error,
            });
        }
    }
}

/**
 * Build the aborted outcome of one route's attempt series.
 * @param {Error} error
 * @returns {{ status: 'aborted', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false }}
 */
function buildSeriesAbortResult(error) {
    return {
        status: /** @type {'aborted'} */ ('aborted'),
        result: '',
        error,
        retryable: /** @type {false} */ (false),
        retriesExhausted: /** @type {false} */ (false),
        hardFailover: /** @type {false} */ (false),
    };
}

/**
 * Build the success outcome of one route's attempt series.
 * @param {{ result: string, error: Error }} attemptResult
 * @returns {{ status: 'success', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false }}
 */
function buildSeriesSuccessResult(attemptResult) {
    return {
        status: /** @type {'success'} */ ('success'),
        result: attemptResult.result,
        error: attemptResult.error,
        retryable: /** @type {false} */ (false),
        retriesExhausted: /** @type {false} */ (false),
        hardFailover: /** @type {false} */ (false),
    };
}

/**
 * Build the failure outcome of one route's attempt series.
 * @param {{ error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean }} fields
 * @returns {{ status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean }}
 */
function buildSeriesFailureResult({ error, retryable, retriesExhausted, hardFailover }) {
    return {
        status: /** @type {'failed'} */ ('failed'),
        result: '',
        error,
        retryable,
        retriesExhausted,
        hardFailover,
    };
}

function getAttemptPromptContext({ series, useRepairPrompt, repairFeedback = '' }) {
    if (useRepairPrompt && series.repairPrompt) {
        return {
            prompt: appendRepairFeedback(series.repairPrompt, repairFeedback),
            metadata: { ...series.metadata, layer0Repair: true },
        };
    }
    return {
        prompt: series.prompt,
        metadata: series.metadata,
    };
}

function logRetryStopReason(reason, maxRetries) {
    if (reason === 'hard-failover') {
        trace('  HARD NETWORK FAILURE, SKIPPING RETRIES FOR THIS ROUTE');
        return;
    }

    if (reason === 'non-retryable') {
        trace('  ERROR IS NON-RETRYABLE, BREAKING');
        return;
    }

    if (reason === 'primary-probe-failed' || reason === 'retries-exhausted') {
        trace('  MAX RETRIES EXHAUSTED');
        if (reason === 'primary-probe-failed') {
            debug('Primary probe failed; trying fallback without additional retries.');
        } else {
            logError(`All ${maxRetries} retries exhausted.`);
        }
    }
}

/**
 * Log and toast an abort and return the sentinel '' value.
 * @returns {string} Always ''
 */
function abortWithToast() {
    debug('Summarization aborted by user.');
    toastr.warning('Summarization aborted.', TOAST_TITLE, { timeOut: 3000 });
    return '';
}

/**
 * @typedef {Error & {
 *   status?: number,
 *   response?: { status?: number },
 *   easyContextGuard?: boolean,
 * }} SummarizerFailureError
 */

/**
 * Toast and log a terminal summarization failure.
 * @param {SummarizerFailureError} lastError
 * @param {{ retriesExhausted?: boolean }} [options]
 * @returns {string} Always ''
 */
function failSummarization(lastError, { retriesExhausted = true } = {}) {
    if (lastError?.easyContextGuard) {
        logError('Summarization blocked by Easy context guard:', lastError);
        trace('<<< EXITING callSummarizer WITH EASY CONTEXT GUARD');
        return '';
    }

    const status = lastError?.status || lastError?.response?.status || '';
    const retryText = retriesExhausted ? ` after ${RETRY_CONFIG.maxRetries} retries` : '';
    logError(`Summarization failed${retryText}:`, lastError);
    toastr.error(
        `Summarization failed${retryText}${status ? ` (${status})` : ''}. Batch skipped; will retry on next trigger.`,
        TOAST_TITLE,
        { timeOut: 8000 },
    );
    trace('<<< EXITING callSummarizer WITH FAILURE');
    return '';
}
