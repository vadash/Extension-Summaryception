import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { debug, error as logError, info, trace } from '../foundation/logger.js';
import { RETRY_CONFIG, ROUTE_CYCLE_FAILURE_BUDGET } from '../foundation/retry.js';
import { silentAdapter } from './notify.js';
import { notifyRouteCycleFailedAndWait, runRouteSeries } from './request-series.js';

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

function shouldTryNextRoute(result) {
    return result.status === 'hard-failover' || isRetryExhaustion(result);
}

/**
 * A retryable series ending implies the retry budget ran out: the series
 * surfaces `rejected` or `failed{retryable}` exclusively after exhausting
 * its budget, and `hard-failover` after skipping it.
 * @param {import('./request-series.js').RouteSeriesResult} result
 * @returns {boolean}
 */
function isRetryExhaustion(result) {
    return (
        result.status === 'rejected' || (result.status === 'failed' && result.retryable === true)
    );
}

/**
 * Terminal hops feed the "after N attempts" failure log; completed and
 * aborted hops carry no count into it.
 * @param {import('./request-series.js').RouteSeriesResult} result
 * @returns {number}
 */
function hopAttempts(result) {
    return result.status === 'completed' || result.status === 'aborted' ? 0 : result.attempts;
}

/**
 * Every non-completed series ending carries the attempt's error.
 * @param {import('./request-series.js').RouteSeriesResult} result
 * @returns {SummarizerFailureError}
 */
function seriesError(result) {
    return /** @type {SummarizerFailureError} */ (result.error);
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

function logFallbackRoute(lastResult, connection) {
    info(
        `Primary summarizer failed${
            lastResult.status === 'hard-failover'
                ? ' (hard network failure)'
                : ' after retryable errors'
        }; trying fallback ` + `(${connection.connectionSource}).`,
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
     * @param {string} p.prompt - Fully substituted user prompt
     * @param {string} p.repairPrompt - Fully substituted Layer 0 repair prompt
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
     * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter for mid-run notices; defaults to the silent adapter
     * @returns {Promise<import('./run-outcome.js').RunOutcome>} Structured outcome; `completed` carries the summary text and the resolved profile.
     */
    async run({ prompt, repairPrompt, signal, profile, notify = silentAdapter }) {
        // Shared, read-only context for every route cycle and attempt of this request.
        const series = {
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
        const { healthBucket, routes } = series.profile.policy;
        let last = null;
        let attempts = 0;

        for (let index = 0; index < routes.length; index++) {
            const route = routes[index];
            let attemptState;
            if (index === 0) {
                const probe =
                    routes.length > 1 && this.primaryRetryExhaustedBuckets.has(healthBucket);
                attemptState = {
                    routeLabel: 'primary',
                    maxRetries: probe ? 0 : RETRY_CONFIG.maxRetries,
                };
                logPrimaryProbe(healthBucket, attemptState.maxRetries);
            } else {
                logFallbackRoute(last, route.connection);
                attemptState = { routeLabel: 'fallback', maxRetries: RETRY_CONFIG.maxRetries };
            }

            last = await runRouteSeries({
                prompt: series.prompt,
                repairPrompt: series.repairPrompt,
                signal: series.signal,
                profile: series.profile,
                route,
                routeLabel: attemptState.routeLabel,
                maxRetries: attemptState.maxRetries,
                notify: series.notify,
            });
            attempts += hopAttempts(last);

            const terminal = this.resolveTerminalHopResult(last, {
                index,
                attempts,
                healthBucket,
                series,
            });
            if (terminal) {
                return terminal;
            }
            if (index < routes.length - 1 && shouldTryNextRoute(last)) {
                continue;
            }
            break;
        }

        // resolveCallProfile always yields at least a primary hop, so the loop set last.
        const settled = /** @type {NonNullable<typeof last>} */ (last);

        if (routes.length === 1) {
            this.primaryRetryExhaustedBuckets.delete(healthBucket);
            return buildRouteCycleResult(
                failSummarization(
                    seriesError(settled),
                    { retriesExhausted: isRetryExhaustion(settled), attempts },
                    series.notify,
                ),
            );
        }

        await notifyRouteCycleFailedAndWait({
            healthBucket,
            signal: series.signal,
            notify: series.notify,
        });
        this.primaryRetryExhaustedBuckets.delete(healthBucket);
        return {
            status: /** @type {'retry'} */ ('retry'),
            result: null,
            outcome: failSummarization(seriesError(settled), { attempts }, series.notify),
        };
    }

    /**
     * Classify one hop's Route Series Result into a terminal route-cycle
     * result, or return null when the walk may consider the next hop. Only a
     * primary-hop success clears the retry-exhausted bucket; only a
     * primary-hop exhaustion sets it, so the next request probes the primary
     * route once.
     * @param {import('./request-series.js').RouteSeriesResult} last
     * @param {{ index: number, attempts: number, healthBucket: string, series: object }} hop
     * @returns {object | null}
     */
    resolveTerminalHopResult(last, { index, attempts, healthBucket, series }) {
        if (last.status === 'completed') {
            if (index === 0) {
                this.primaryRetryExhaustedBuckets.delete(healthBucket);
            }
            return buildRouteCycleResult(buildCompletedOutcome(last.text, series.profile));
        }
        if (last.status === 'aborted') {
            return buildRouteCycleResult(abortRun(series.notify));
        }
        if (!isRetryExhaustion(last) && last.status !== 'hard-failover') {
            return buildRouteCycleResult(
                failSummarization(
                    seriesError(last),
                    { retriesExhausted: false, attempts },
                    series.notify,
                ),
            );
        }
        if (index === 0 && isRetryExhaustion(last)) {
            this.primaryRetryExhaustedBuckets.add(healthBucket);
        }
        return null;
    }
}

/**
 * Stopping a run is not a failure. Entry renders the notice from this
 * structured event (ADR-0019).
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
