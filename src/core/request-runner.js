import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { debug, error as logError, info, trace } from '../foundation/logger.js';
import { RETRY_CONFIG, ROUTE_CYCLE_FAILURE_BUDGET } from '../foundation/retry.js';
import { silentAdapter } from './notify.js';
import { getRetryStopReason, shouldSwitchToRepairPrompt } from './request-retry-policy.js';
import {
    appendRepairFeedback,
    classifyAttemptError,
    notifyRetryAndWait,
    notifyRouteCycleFailedAndWait,
    runSingleAttempt,
} from './request-attempt.js';
import {
    createAttemptLogState,
    logLlmAttemptTransaction,
    updateAttemptLogState,
} from './request-attempt-log.js';

/**
 * Structured result of one summarizer request: {@link import('./run-outcome.js').RunOutcome}.
 * Completed outcomes carry the resolved profile for post-hoc validation.
 */

function buildCompletedOutcome(text, profile) {
    return {
        status: /** @type {'completed'} */ ('completed'),
        text,
        profile,
    };
}

function buildAbortedOutcome() {
    return { status: /** @type {'aborted'} */ ('aborted') };
}

function buildBlockedOutcome() {
    return { status: /** @type {'blocked'} */ ('blocked') };
}

function buildFailedOutcome(attempts) {
    return { status: /** @type {'failed'} */ ('failed'), attempts };
}

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
     * @param {ExtensionSettings} p.settings
     * @param {string} p.prompt - Fully substituted user prompt
     * @param {string} p.repairPrompt - Fully substituted Layer 0 repair prompt
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
     * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter for mid-run notices; defaults to the silent adapter
     * @returns {Promise<import('./run-outcome.js').RunOutcome>} Structured outcome; `completed` carries the summary text and the resolved profile.
     */
    async run({ settings, prompt, repairPrompt, signal, profile, notify = silentAdapter }) {
        // Shared, read-only context for every route cycle and attempt of this request.
        const series = {
            settings,
            prompt,
            repairPrompt,
            signal,
            profile,
            notify,
            routeCycleFailures: 0,
        };

        while (true) {
            if (series.signal.aborted) {
                return abortRun(series.notify);
            }

            const cycle = await this.runRouteCycle(series);

            if (cycle.status === 'retry') {
                series.routeCycleFailures += 1;
                if (series.routeCycleFailures >= ROUTE_CYCLE_FAILURE_BUDGET) {
                    return cycle.outcome;
                }
                continue;
            }

            return cycle.result;
        }
    }

    async runRouteCycle(series) {
        const healthBucket = series.profile.policy.healthBucket;
        const primary = await this.runPrimaryAttemptSeries(series);

        const resolvedPrimary = this.resolvePrimaryRouteResult(primary, healthBucket, series);
        if (resolvedPrimary) {
            return resolvedPrimary;
        }

        if (shouldTryFallbackRoute(primary, series.profile.policy.fallbackConnection)) {
            return await this.runFallbackRouteCycle(series, primary);
        }

        if (!primary.retryable) {
            return buildRouteCycleResult(
                failSummarization(
                    primary.error,
                    {
                        retriesExhausted: false,
                        attempts: primary.status === 'failed' ? primary.attempts : 0,
                    },
                    series.notify,
                ),
            );
        }

        this.primaryRetryExhaustedBuckets.delete(healthBucket);
        return buildRouteCycleResult(
            failSummarization(
                primary.error,
                { attempts: primary.status === 'failed' ? primary.attempts : 0 },
                series.notify,
            ),
        );
    }

    async runPrimaryAttemptSeries(series) {
        const healthBucket = series.profile.policy.healthBucket;
        const maxRetries =
            series.profile.policy.fallbackConnection &&
            this.primaryRetryExhaustedBuckets.has(healthBucket)
                ? 0
                : RETRY_CONFIG.maxRetries;

        logPrimaryProbe(healthBucket, maxRetries);
        return await this.runAttemptSeries(series, {
            routeLabel: 'primary',
            maxRetries,
        });
    }

    resolvePrimaryRouteResult(primary, healthBucket, series) {
        if (primary.status === 'success') {
            this.primaryRetryExhaustedBuckets.delete(healthBucket);
            return buildRouteCycleResult(buildCompletedOutcome(primary.result, series.profile));
        }
        if (primary.status === 'aborted') {
            return buildRouteCycleResult(abortRun(series.notify));
        }
        if (!primary.retryable && !primary.hardFailover) {
            return buildRouteCycleResult(
                failSummarization(
                    primary.error,
                    {
                        retriesExhausted: false,
                        attempts: primary.attempts,
                    },
                    series.notify,
                ),
            );
        }

        if (primary.retriesExhausted) {
            this.primaryRetryExhaustedBuckets.add(healthBucket);
        }
        return null;
    }

    async runFallbackRouteCycle(series, primary) {
        logFallbackRoute(primary, series.profile.policy.fallbackConnection);
        const fallback = await this.runAttemptSeries(series, {
            routeLabel: 'fallback',
            maxRetries: RETRY_CONFIG.maxRetries,
        });

        if (fallback.status === 'success') {
            return buildRouteCycleResult(buildCompletedOutcome(fallback.result, series.profile));
        }
        if (fallback.status === 'aborted') {
            return buildRouteCycleResult(abortRun(series.notify));
        }

        await notifyRouteCycleFailedAndWait({
            healthBucket: series.profile.policy.healthBucket,
            signal: series.signal,
            notify: series.notify,
        });
        this.primaryRetryExhaustedBuckets.delete(series.profile.policy.healthBucket);
        return {
            status: /** @type {'retry'} */ ('retry'),
            result: null,
            outcome: failSummarization(
                fallback.error,
                { attempts: primary.attempts + fallback.attempts },
                series.notify,
            ),
        };
    }

    /**
     * Run retry attempts for one resolved connection route.
     * @param {object} series - Shared request context built by run()
     * @param {object} attemptState - Per-route state for this attempt series
     * @param {string} attemptState.routeLabel - Human-readable route label for trace logs
     * @param {number} attemptState.maxRetries - Maximum retry count for this route
     * @returns {Promise<{ status: 'success', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false } | { status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean, attempts: number } | { status: 'aborted', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false }>}
     */
    async runAttemptSeries(series, attemptState) {
        const { maxRetries } = attemptState;
        /** @type {Error & { status?: number, response?: { status?: number } }} */
        let lastError = new Error('no error');
        let attempts = 0;
        let useRepairPrompt = false;
        let repairFeedback = '';

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (series.signal.aborted) {
                return buildSeriesAbortResult(lastError);
            }
            attempts++;
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
                    attempts,
                });
            }

            if (shouldUseRepairPrompt) {
                useRepairPrompt = true;
                repairFeedback = attemptResult.repairFeedback || '';
            }

            await notifyRetryAndWait({
                lastError,
                attempt,
                signal: series.signal,
                maxRetries,
                notify: series.notify,
            });
        }
        return buildSeriesFailureResult({
            error: lastError,
            retryable: true,
            retriesExhausted: true,
            hardFailover: false,
            attempts,
        });
    }

    async executePreparedAttempt(series, attemptState) {
        const promptContext = getAttemptPromptContext({
            series,
            useRepairPrompt: attemptState.useRepairPrompt,
            repairFeedback: attemptState.repairFeedback,
        });
        const isFallbackRoute = attemptState.routeLabel === 'fallback';
        return await this.executeAttempt(series, {
            ...attemptState,
            prompt: promptContext.prompt,
            connection: isFallbackRoute
                ? series.profile.policy.fallbackConnection
                : series.profile.policy.primaryConnection,
            layer0Repair: attemptState.useRepairPrompt,
            timeoutMs: isFallbackRoute
                ? series.profile.policy.fallbackTimeoutMs
                : series.profile.policy.primaryTimeoutMs,
        });
    }

    /**
     * Run a single summarizer attempt and classify the outcome.
     * @param {object} series - Shared request context built by run()
     * @param {object} attemptState - Per-attempt state prepared by executePreparedAttempt
     * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean, failureStatus?: string, repairFeedback?: string }>}
     */
    async executeAttempt(series, attemptState) {
        const {
            prompt,
            attempt,
            connection,
            layer0Repair,
            repairFeedback,
            routeLabel,
            maxRetries,
            timeoutMs,
        } = attemptState;
        trace(`  ${routeLabel} attempt ${attempt} starting...`);
        const startedAt = Date.now();
        const logState = createAttemptLogState();

        try {
            const result = await runSingleAttempt({
                settings: series.settings,
                systemPrompt: series.profile.policy.systemPrompt,
                prompt,
                signal: series.signal,
                attempt,
                profile: series.profile,
                connection,
                layer0Repair,
                repairFeedback,
                notify: series.notify,
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
                label: series.profile.policy.label,
                routeLabel,
                attempt,
                status: logState.status,
                durationMs: Date.now() - startedAt,
                systemPrompt: series.profile.policy.systemPrompt,
                prompt,
                cleanedResult: logState.cleanedResult,
                error: logState.error,
            });
        }
    }
}

/**
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
 * @param {{ error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean, attempts: number }} fields
 * @returns {{ status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean, attempts: number }}
 */
function buildSeriesFailureResult({ error, retryable, retriesExhausted, hardFailover, attempts }) {
    return {
        status: /** @type {'failed'} */ ('failed'),
        result: '',
        error,
        retryable,
        retriesExhausted,
        hardFailover,
        attempts,
    };
}

function getAttemptPromptContext({ series, useRepairPrompt, repairFeedback = '' }) {
    if (useRepairPrompt && series.repairPrompt) {
        return {
            prompt: appendRepairFeedback(series.repairPrompt, repairFeedback),
        };
    }
    return {
        prompt: series.prompt,
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
 * Stopping a run is not a failure. Entry renders the notice from this
 * structured event (ADR-0004).
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the request series
 * @returns {import('./run-outcome.js').RunOutcome} The aborted outcome
 */
function abortRun(notify) {
    debug('Summarization aborted by user.');
    notify.transient({ kind: NOTIFY_EVENTS.RUN_ABORTED });
    return buildAbortedOutcome();
}

/**
 * @typedef {Error & {
 *   status?: number,
 *   response?: { status?: number },
 *   easyContextGuard?: boolean,
 * }} SummarizerFailureError
 */

/**
 * The guard-block branch emits no event because the attempt layer already
 * emitted the guard event.
 * @param {SummarizerFailureError} lastError
 * @param {{ retriesExhausted?: boolean, attempts?: number }} [options]
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the request series
 * @returns {import('./run-outcome.js').RunOutcome} The blocked or failed outcome
 */
function failSummarization(
    lastError,
    { retriesExhausted = true, attempts = 0 } = {},
    notify = silentAdapter,
) {
    if (lastError?.easyContextGuard) {
        logError('Summarization blocked by Easy context guard:', lastError);
        trace('<<< EXITING callSummarizer WITH EASY CONTEXT GUARD');
        return buildBlockedOutcome();
    }

    const status = lastError?.status || lastError?.response?.status || '';
    const retryText = retriesExhausted ? ` after ${attempts} attempts` : '';
    logError(`Summarization failed${retryText}:`, lastError);
    notify.transient({
        kind: NOTIFY_EVENTS.RUN_FAILED,
        retriesExhausted,
        attempts,
        status: status || null,
    });
    trace('<<< EXITING callSummarizer WITH FAILURE');
    return buildFailedOutcome(attempts);
}
