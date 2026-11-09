import { NOTIFY_EVENTS } from '../foundation/constants.js';
import {
    debug,
    error as logError,
    info,
    isTraceEnabled,
    trace,
    warn,
    serializeError,
} from '../foundation/logger.js';
import { RETRY_CONFIG, ROUTE_CYCLE_FAILURE_BUDGET, sleepOrAbort } from '../foundation/retry.js';
import { appendRecallFeedback } from '../foundation/prompt-parts.js';
import { silentAdapter } from './notify.js';
import {
    ConnectionError,
    isCancellableConnection,
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    classifyAttemptRetryStatus,
    computeRetryDelay,
    getRetryStopReason,
    notifyRetryAndWait,
    shouldSwitchToRepairPrompt,
    ROUTE_CYCLE_RETRY_ATTEMPT,
} from './request-retry-policy.js';
import {
    createAttemptLogState,
    logLlmAttemptTransaction,
    updateAttemptLogState,
} from './request-attempt-log.js';
import { processSummarizerResponse } from './summarizer-output.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import { buildLayer0RetryTighteningLine, resolveL0RetryBaseCap } from './repair-diagnostics.js';

/**
 * One attempt's settled outcome. `rejected` drops the repair payloads, which
 * only the per-attempt transaction log and the repair switch read.
 *
 * @typedef {object} AttemptResult
 * @property {'completed' | 'aborted' | 'hard-failover' | 'failed' | 'rejected' | 'guard-stopped'} status - Settled outcome kind.
 * @property {string} [text] - `completed`: the accepted summary text; `rejected`: the cleaned LLM output for the transaction log.
 * @property {Error} [error] - The attempt's error; absent on `completed`.
 * @property {boolean} [retryable] - `failed` only.
 * @property {string} [reason] - `rejected` only: the Output Hygiene rejection status.
 * @property {string} [repairFeedback] - `rejected` only: feedback for the repair prompt.
 */

/**
 * A hop whose retry budget ran out or whose connection failed hard: the walk
 * moves to the next route, carrying what the cycle verdict needs.
 *
 * @typedef {object} HopAdvance
 * @property {true} advance - Marks the settlement as an advance signal.
 * @property {'hard-failover' | 'primary-probe-failed' | 'retries-exhausted'} reason - The `getRetryStopReason` verdict that ended the hop.
 * @property {Error} error - The terminal attempt's error.
 * @property {number} attempts - Attempts started in this hop.
 */

/**
 * A hop either settles the whole call or hands the walk to the next route.
 * @typedef {import('./run-outcome.js').RunOutcome | HopAdvance} HopSettlement
 */

/**
 * The Run Outcome of one summarizer request. Completed outcomes carry the
 * accepted text and the profile it was accepted under, so callers never
 * re-validate the text.
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

/**
 * Retryable exhaustion is the only advance reason that marks the health
 * bucket: the primary route used its whole budget, so the next call probes it
 * once. A hard failover leaves the bucket alone.
 * @param {HopAdvance['reason']} reason
 * @returns {boolean}
 */
function isRetryBudgetExhaustion(reason) {
    return reason === 'retries-exhausted' || reason === 'primary-probe-failed';
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

/**
 * @param {HopAdvance} lastAdvance - The primary hop's advance signal
 * @param {ExtensionSettings} connection - The fallback route's connection
 */
function logFallbackRoute(lastAdvance, connection) {
    info(
        `Primary summarizer failed${
            lastAdvance.reason === 'hard-failover'
                ? ' (hard network failure)'
                : ' after retryable errors'
        }; trying fallback ` + `(${connection.connectionSource}).`,
    );
}

/**
 * The repair retry swaps both halves of the question: the payload template and
 * the recall body. The attempt feedback lands inside the recall block, above
 * its limits, so the execution trigger stays the final line.
 * @param {object} p
 * @param {string} p.prompt - Base payload message
 * @param {string} p.repairPrompt - Repair payload message
 * @param {string} p.recall - Base recall message
 * @param {string} p.repairRecall - Repair recall message
 * @param {boolean} p.useRepairPrompt - Whether the repair retry is active
 * @param {string} p.repairFeedback - Attempt-local feedback from the rejected draft
 * @param {string} [p.tighteningLine] - Layer 0 retry cap line; empty omits it
 * @returns {{ prompt: string, recall: string }}
 */
function buildAttemptMessages({
    prompt,
    repairPrompt,
    recall,
    repairRecall,
    useRepairPrompt,
    repairFeedback,
    tighteningLine = '',
}) {
    const feedback = [String(repairFeedback ?? ''), String(tighteningLine ?? '')]
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
    if (useRepairPrompt && repairPrompt) {
        return {
            prompt: repairPrompt,
            recall: appendRecallFeedback(repairRecall, feedback),
        };
    }
    return { prompt, recall };
}

/**
 * Run summarizer provider requests with retry and fallback routing.
 */
export class RequestRunner {
    constructor() {
        this.primaryRetryExhaustedBuckets = new Set();
    }

    /**
     * Walk one summarizer call to its Run Outcome: route cycles times attempt
     * retries. The walk owns the route-cycle failure budget, health-bucket
     * probing, hop failover, the repair switch, retry and cycle waits, and the
     * verdicts; transport and the Usage Ledger enter as injected adapters.
     * @param {object} p
     * @param {string} p.prompt - Fully substituted payload message
     * @param {string} p.repairPrompt - Fully substituted Layer 0 repair payload
     * @param {string} p.recall - The recall message closing the request
     * @param {string} p.repairRecall - The repair attempt's recall message
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
     * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter for mid-run notices; defaults to the silent adapter
     * @param {import('./summarizer-usage.js').UsageLedger} p.usage - Usage Ledger this call records token usage into
     * @returns {Promise<import('./run-outcome.js').RunOutcome>} Structured outcome; `completed` carries the summary text and the resolved profile.
     */
    async run({
        prompt,
        repairPrompt,
        recall,
        repairRecall,
        signal,
        profile,
        notify = silentAdapter,
        usage,
    }) {
        const { healthBucket, routes } = profile.policy;
        let routeCycleFailures = 0;

        while (true) {
            if (signal.aborted) {
                return abortRun(notify);
            }

            /** @type {HopAdvance | null} */
            let lastAdvance = null;
            let attempts = 0;

            for (let index = 0; index < routes.length; index++) {
                const route = routes[index];
                let routeLabel;
                let maxRetries;

                if (index === 0) {
                    const probe =
                        routes.length > 1 && this.primaryRetryExhaustedBuckets.has(healthBucket);
                    routeLabel = 'primary';
                    maxRetries = probe ? 0 : RETRY_CONFIG.maxRetries;
                    logPrimaryProbe(healthBucket, maxRetries);
                } else {
                    logFallbackRoute(/** @type {HopAdvance} */ (lastAdvance), route.connection);
                    routeLabel = 'fallback';
                    maxRetries = RETRY_CONFIG.maxRetries;
                }

                const settled = await runHop({
                    prompt,
                    repairPrompt,
                    recall,
                    repairRecall,
                    signal,
                    profile,
                    notify,
                    usage,
                    route,
                    routeLabel,
                    maxRetries,
                    priorAttempts: attempts,
                });

                if (!('advance' in settled)) {
                    if (settled.status === 'completed' && index === 0) {
                        this.primaryRetryExhaustedBuckets.delete(healthBucket);
                    }
                    return settled;
                }

                lastAdvance = settled;
                attempts += settled.attempts;
                if (index === 0 && isRetryBudgetExhaustion(settled.reason)) {
                    this.primaryRetryExhaustedBuckets.add(healthBucket);
                }
            }

            // resolveCallProfile always yields at least one route, so the loop set lastAdvance.
            const last = /** @type {HopAdvance} */ (lastAdvance);

            if (routes.length === 1) {
                this.primaryRetryExhaustedBuckets.delete(healthBucket);
                return failSummarization(
                    last.error,
                    { retriesExhausted: isRetryBudgetExhaustion(last.reason), attempts },
                    notify,
                );
            }

            await notifyRouteCycleFailedAndWait({ healthBucket, signal, notify });
            this.primaryRetryExhaustedBuckets.delete(healthBucket);
            routeCycleFailures += 1;
            if (routeCycleFailures >= ROUTE_CYCLE_FAILURE_BUDGET) {
                return failSummarization(last.error, { attempts }, notify);
            }
        }
    }
}

/**
 * Run one connection route's attempts with the repair switch and retry waits
 * until an attempt settles terminally or the retry budget runs out. The
 * repair switch is per hop: a fallback hop starts back on the base prompt.
 * @param {object} p
 * @param {string} p.prompt - Fully substituted payload message
 * @param {string} p.repairPrompt - Fully substituted repair payload
 * @param {string} p.recall - The recall message closing the request
 * @param {string} p.repairRecall - The repair attempt's recall message
 * @param {AbortSignal} p.signal - Abort signal
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for mid-run notices
 * @param {import('./summarizer-usage.js').UsageLedger} p.usage - Usage Ledger this hop records token usage into
 * @param {import('./call-profile.js').CallProfileRoute} p.route - Resolved connection and timeout for this hop
 * @param {string} p.routeLabel - Route label for structured logs
 * @param {number} p.maxRetries - Retry budget for this hop
 * @param {number} p.priorAttempts - Attempts already spent in earlier hops
 * @returns {Promise<HopSettlement>}
 */
async function runHop({
    prompt,
    repairPrompt,
    recall,
    repairRecall,
    signal,
    profile,
    notify,
    usage,
    route,
    routeLabel,
    maxRetries,
    priorAttempts,
}) {
    /** @type {Error} */
    let lastError = new Error('no error');
    let attempts = 0;
    let useRepairPrompt = false;
    let repairFeedback = '';
    let rejectedDraft = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) {
            return abortRun(notify);
        }
        attempts++;
        trace(`  ${routeLabel} attempt ${attempt} starting...`);
        if (attempt > 0) {
            debug(`${routeLabel} retry attempt ${attempt}/${maxRetries}`);
        }

        const messages = buildAttemptMessages({
            prompt,
            repairPrompt,
            recall,
            repairRecall,
            useRepairPrompt,
            repairFeedback,
            tighteningLine: buildLayer0RetryTighteningLine({
                attempt,
                baseCap: resolveL0RetryBaseCap(profile),
                rejectedDraft,
            }),
        });
        const attemptResult = await runLoggedAttempt({
            prompt: messages.prompt,
            recall: messages.recall,
            signal,
            attempt,
            profile,
            connection: route.connection,
            timeoutMs: route.timeoutMs,
            routeLabel,
            notify,
            usage,
        });

        if (attemptResult.status === 'completed') {
            return buildCompletedOutcome(attemptResult.text, profile);
        }

        lastError = /** @type {Error} */ (attemptResult.error);

        if (attemptResult.status === 'aborted') {
            return abortRun(notify);
        }

        const stopReason = getRetryStopReason(
            /** @type {{ status: 'hard-failover' | 'guard-stopped' | 'failed' | 'rejected', retryable?: boolean }} */ (
                attemptResult
            ),
            attempt,
            maxRetries,
        );
        if (stopReason) {
            logRetryStopReason(stopReason, maxRetries);
            if (stopReason === 'non-retryable') {
                return failSummarization(
                    lastError,
                    { retriesExhausted: false, attempts: priorAttempts + attempts },
                    notify,
                );
            }
            return { advance: true, reason: stopReason, error: lastError, attempts };
        }

        if (attemptResult.status === 'rejected') {
            rejectedDraft = attemptResult.text || '';
        }

        if (shouldSwitchToRepairPrompt({ attemptResult, attempt, maxRetries, repairPrompt })) {
            useRepairPrompt = true;
            repairFeedback = attemptResult.repairFeedback || '';
        }

        await notifyRetryAndWait({ lastError, attempt, signal, maxRetries, notify });
    }

    return { advance: true, reason: 'retries-exhausted', error: lastError, attempts };
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
 * Cycle-level policy: both hops of the Narrative Chain failed, so notify,
 * wait the cycle backoff, and let the walk restart from primary.
 * @param {object} p
 * @param {string} p.healthBucket - Health bucket the cycle exhausted.
 * @param {AbortSignal} p.signal - Signal that cuts the wait short.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter threaded from the walk.
 * @returns {Promise<void>}
 */
async function notifyRouteCycleFailedAndWait({ healthBucket, signal, notify }) {
    const delay = computeRetryDelay(new Error('Both routes failed'), ROUTE_CYCLE_RETRY_ATTEMPT);
    const delaySec = (delay / 1000).toFixed(1);
    info(
        `Both primary and fallback exhausted for ${healthBucket}; ` +
            `resetting health state and retrying primary in ${delaySec}s.`,
    );
    notify.transient({
        kind: NOTIFY_EVENTS.ROUTE_CYCLE_WAIT,
        delayMs: delay,
    });
    await sleepOrAbort(delay, signal);
}

/**
 * Stopping a run is not a failure. Entry renders the notice from this
 * structured event (ADR-0019).
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the call walk
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
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the call walk
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

/**
 * Run one attempt and record its per-attempt transaction log; never throws.
 * Provider throws are classified onto the attempt vocabulary.
 * @param {object} p
 * @param {string} p.prompt - Fully substituted user prompt for this attempt.
 * @param {string} p.recall - The recall message closing the request.
 * @param {AbortSignal} p.signal - Abort signal for the request.
 * @param {number} p.attempt - Zero-based attempt index.
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch.
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route.
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds.
 * @param {string} p.routeLabel - Route label for structured logs.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for mid-run notices.
 * @param {import('./summarizer-usage.js').UsageLedger} p.usage - Usage Ledger this attempt records token usage into.
 * @returns {Promise<AttemptResult>}
 */
async function runLoggedAttempt({
    prompt,
    recall,
    signal,
    attempt,
    profile,
    connection,
    timeoutMs,
    routeLabel,
    notify,
    usage,
}) {
    const startedAt = Date.now();
    const logState = createAttemptLogState();
    /** @type {AttemptResult} */
    let attemptResult;
    try {
        attemptResult = await runAttempt({
            prompt,
            recall,
            signal,
            profile,
            connection,
            timeoutMs,
            notify,
            usage,
        });
        updateAttemptLogState(logState, attemptResult);
    } catch (err) {
        attemptResult = classifyAttemptError(err, signal);
        updateAttemptLogState(logState, attemptResult);
    } finally {
        logLlmAttemptTransaction({
            label: profile.policy.label,
            routeLabel,
            attempt,
            status: logState.status,
            durationMs: Date.now() - startedAt,
            systemPrompt: profile.policy.systemPrompt,
            prompt,
            recall,
            cleanedResult: logState.cleanedResult,
            error: logState.error,
        });
    }
    return attemptResult;
}

/**
 * Run one summarizer request attempt through guard, send, and result
 * processing. Throws on provider errors; the walk classifies them.
 * @param {object} p
 * @param {string} p.prompt - Fully substituted user prompt.
 * @param {string} p.recall - The recall message closing the request.
 * @param {AbortSignal} p.signal - Abort signal for the request.
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch.
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route.
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for mid-run notices.
 * @param {import('./summarizer-usage.js').UsageLedger} p.usage - Usage Ledger this attempt records token usage into.
 * @returns {Promise<AttemptResult>}
 */
async function runAttempt({
    prompt,
    recall,
    signal,
    profile,
    connection,
    timeoutMs,
    notify,
    usage,
}) {
    // One read-through: the frozen Call Profile is the only source of the
    // system prompt; no helper receives it as a second, parallel fact.
    const systemPrompt = profile.policy.systemPrompt;
    const guardFailure = await getEasyContextGuardFailure({ prompt, profile, notify });
    if (guardFailure) {
        return guardFailure;
    }

    await traceSummarizerRequest({ connection, systemPrompt, prompt, recall });
    const rawResult = await sendAttemptRequest({
        connection,
        systemPrompt,
        prompt,
        recall,
        signal,
        timeoutMs,
    });
    trace('  sendSummarizerRequest returned:', rawResult?.substring?.(0, 50));
    return await processAttemptResult({ rawResult, prompt, recall, profile, notify, usage });
}

/**
 * @param {object} p
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
 * @param {import('./notify.js').NotifyAdapter} p.notify
 * @returns {Promise<AttemptResult | null>} `guard-stopped` when the guard blocks, else null
 */
async function getEasyContextGuardFailure({ prompt, profile, notify }) {
    const guard = await checkEasyContextGuard(profile, prompt);
    if (guard.ok) {
        return null;
    }

    const guardError = buildEasyContextGuardError(guard);
    warn(guardError.message);
    notify.transient({
        kind: NOTIFY_EVENTS.EASY_GUARD_BLOCKED,
        label: guard.label,
        tokens: guard.tokens.count,
        estimated: guard.tokens.estimated,
        limit: guard.limit,
    });
    return { status: 'guard-stopped', error: guardError };
}

/**
 * @param {object} p
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {string} p.recall - The recall message closing the request
 * @param {AbortSignal} p.signal - Abort signal for the request
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds
 * @returns {Promise<string>} Raw provider output
 */
async function sendAttemptRequest({ connection, systemPrompt, prompt, recall, signal, timeoutMs }) {
    const timeoutRetryable = isCancellableConnection(connection);
    const abortContext = createAttemptAbortContext(signal, timeoutMs, timeoutRetryable);

    try {
        return await Promise.race([
            sendSummarizerRequest({
                settings: connection,
                systemPrompt,
                userPrompt: prompt,
                recall,
                signal: abortContext.signal,
            }),
            abortContext.promise,
        ]);
    } finally {
        abortContext.cleanup();
    }
}

/**
 * @param {object} p
 * @param {string} p.rawResult - Raw provider output
 * @param {string} p.prompt - Fully substituted payload message
 * @param {string} p.recall - The recall message closing the request
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
 * @param {import('./notify.js').NotifyAdapter} p.notify
 * @param {import('./summarizer-usage.js').UsageLedger} p.usage - Usage Ledger this attempt records token usage into
 * @returns {Promise<AttemptResult>}
 */
async function processAttemptResult({ rawResult, prompt, recall, profile, notify, usage }) {
    const processed = await processSummarizerResponse(rawResult, profile, notify);
    if (processed.status !== 'success') {
        logProcessedAttemptFailure(processed.status);
        return {
            status: 'rejected',
            reason: processed.status,
            text: processed.text,
            repairFeedback: processed.repairFeedback,
            error: processed.error,
        };
    }

    await usage.record({
        systemPrompt: profile.policy.systemPrompt,
        prompt,
        recall,
        summary: processed.text,
        profile,
    });
    trace('<<< EXITING callSummarizer WITH SUCCESS');
    return { status: 'completed', text: processed.text };
}

function logProcessedAttemptFailure(status) {
    if (status === 'empty') {
        debug('Empty response from LLM, treating as retryable');
    } else if (status === 'integrity-rejected') {
        debug('Summarizer output failed integrity validation, treating as retryable');
    } else if (status === 'size-rejected') {
        debug('Summarizer output failed size validation, treating as retryable');
    }
}

/**
 * @param {object} p
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted payload message
 * @param {string} p.recall - The recall message closing the request
 * @returns {Promise<void>}
 */
async function traceSummarizerRequest({ connection, systemPrompt, prompt, recall }) {
    if (!isTraceEnabled()) {
        return;
    }

    const promptTokens = await countTextTokens(`${prompt}\n\n${recall}`);
    trace('  About to call sendSummarizerRequest with:', {
        connectionSource: connection.connectionSource,
        summarizerSystemPrompt: systemPrompt?.substring(0, 50),
        promptTokens: formatTokenCount(promptTokens),
    });
}

/**
 * @param {unknown} err - Thrown error
 * @param {AbortSignal} signal - Abort signal
 * @returns {AttemptResult}
 */
function classifyAttemptError(err, signal) {
    const error =
        /** @type {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} */ (
            err
        );
    trace('  Caught error on attempt:', serializeError(error));

    const retryStatus = classifyAttemptRetryStatus(error, signal.aborted);
    if (retryStatus.aborted) {
        return { status: 'aborted', error };
    }

    if (retryStatus.hardFailover) {
        info('Hard network failure detected; skipping retries for this route.', error.message);
        return { status: 'hard-failover', error };
    }

    if (!retryStatus.shouldRetry) {
        logError('Non-retryable error:', error);
    }

    return { status: 'failed', retryable: retryStatus.shouldRetry, error };
}

/**
 * Build an attempt-local abort context that closes the provider request on user abort or timeout.
 * @param {AbortSignal} userSignal
 * @param {number} timeoutMs
 * @param {boolean} timeoutRetryable - Whether a fired timeout may be retried; false on
 *   uncancellable routes so the runner fails/fails-over instead of stacking orphaned requests.
 * @returns {{ signal: AbortSignal, promise: Promise<never>, cleanup: () => void }}
 */
function createAttemptAbortContext(userSignal, timeoutMs, timeoutRetryable) {
    const controller = new AbortController();
    let timer;
    let abortUserRequest = () => {};

    /** @type {Promise<never>} */
    const promise = new Promise((_, reject) => {
        const rejectAsUserAbort = () => {
            clearTimeout(timer);
            controller.abort(new Error('Aborted by user'));
            reject(new Error('Aborted by user'));
        };

        abortUserRequest = rejectAsUserAbort;

        if (userSignal.aborted) {
            rejectAsUserAbort();
            return;
        }

        timer = setTimeout(() => {
            const error = new ConnectionError(`Request timed out after ${timeoutMs / 1000}s`, {
                retryable: timeoutRetryable,
            });
            reject(error);
            controller.abort(error);
        }, timeoutMs);

        userSignal.addEventListener('abort', rejectAsUserAbort, { once: true });
    });

    return {
        signal: controller.signal,
        promise,
        cleanup: () => {
            clearTimeout(timer);
            userSignal.removeEventListener('abort', abortUserRequest);
        },
    };
}

/**
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @param {string} prompt - Fully substituted user prompt
 * @returns {Promise<{ ok: true } | { ok: false, limit: number, tokens: { count: number, estimated: boolean }, label: string }>}
 */
async function checkEasyContextGuard(profile, prompt) {
    const limit = profile.policy.easyContextLimit;
    if (limit === null) {
        return { ok: true };
    }

    const requestText = `${profile.policy.systemPrompt || ''}\n\n${prompt || ''}`;
    const tokens = await countTextTokens(requestText);
    if (tokens.count <= limit) {
        return { ok: true };
    }

    return {
        ok: false,
        limit,
        tokens,
        label: profile.policy.label,
    };
}

function buildEasyContextGuardError(guard) {
    const label = guard.label;
    const message =
        `Easy mode blocked ${label}: summarizer request is ` +
        `${formatTokenValue(guard.tokens.count, guard.tokens.estimated)} tokens, above the ` +
        `${formatTokenValue(guard.limit)} Easy Summarizer Context cap. ` +
        'Raise the Easy context slider or switch to Advanced.';
    const error = /** @type {ConnectionError & { easyContextGuard?: boolean }} */ (
        new ConnectionError(message, { retryable: false })
    );
    error.easyContextGuard = true;
    return error;
}
