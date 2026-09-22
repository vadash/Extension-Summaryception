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
import { sleepOrAbort } from '../foundation/retry.js';
import {
    ConnectionError,
    isCancellableConnection,
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    classifyAttemptRetryStatus,
    computeRetryDelay,
    getRetryStopReason,
    shouldSwitchToRepairPrompt,
} from './request-retry-policy.js';
import {
    createAttemptLogState,
    logLlmAttemptTransaction,
    updateAttemptLogState,
} from './request-attempt-log.js';
import { processSummarizerResponse } from './summarizer-output.js';
import { recordSuccessfulSummarizerUsage } from './summarizer-pipeline.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import { EXECUTION_TRIGGER_L0, insertBeforeTrigger } from '../foundation/prompt-parts.js';

/**
 * One attempt's settled outcome — the attempt protocol's vocabulary. A Route
 * Series Result (below) is the same vocabulary at series scope; `rejected`
 * drops the repair payloads, which only the per-attempt transaction log and
 * the repair switch read.
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
 * How one connection route's retry series ended. `failed{retryable}` and
 * `rejected` always imply the retry budget ran out — the series only
 * surfaces a retryable ending instead of retrying. `hard-failover` implies
 * the connection is dead for this route and the remaining retries were
 * skipped. `guard-stopped` means the Easy context guard blocked the request
 * before it was sent.
 *
 * @typedef {object} RouteSeriesResult
 * @property {'completed' | 'aborted' | 'hard-failover' | 'failed' | 'rejected' | 'guard-stopped'} status - Settled outcome kind.
 * @property {string} [text] - `completed`: the accepted summary text.
 * @property {Error} [error] - The attempt's error; absent on `completed`.
 * @property {boolean} [retryable] - `failed` only: the error may clear on retry (the budget already ran out).
 * @property {string} [reason] - `rejected` only: the Output Hygiene rejection status.
 * @property {number} attempts - Attempts started, including the terminal one.
 */

/**
 * Fold accepted repair feedback into the repair prompt.
 * @param {string} prompt
 * @param {string} repairFeedback
 * @returns {string}
 */
function appendRepairFeedback(prompt, repairFeedback) {
    const feedback = String(repairFeedback || '').trim();
    if (!feedback) {
        return prompt;
    }
    return insertBeforeTrigger(prompt, feedback, EXECUTION_TRIGGER_L0);
}

/**
 * The prompt for one attempt: the base user prompt, or the repair prompt
 * once the series switched after a rejected output.
 * @param {string} basePrompt
 * @param {string} repairPrompt
 * @param {boolean} useRepairPrompt
 * @param {string} repairFeedback
 * @returns {string}
 */
function buildAttemptPrompt(basePrompt, repairPrompt, useRepairPrompt, repairFeedback) {
    if (useRepairPrompt && repairPrompt) {
        return appendRepairFeedback(repairPrompt, repairFeedback);
    }
    return basePrompt;
}

/**
 * The facts a Call Session carries, verbatim from its creator. The session
 * exposes them read-only so the Request Runner that built it can run cycle
 * policy (abort checks, cycle notices) off the same object it passed in,
 * without threading the facts twice; derived session state — the repair
 * switch — never appears here.
 * @typedef {object} CallSessionFacts
 * @property {string} prompt - Fully substituted user prompt.
 * @property {string} repairPrompt - Fully substituted repair prompt ('' when the call validates no repair).
 * @property {AbortSignal} signal - Abort signal.
 * @property {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch.
 * @property {import('./notify.js').NotifyAdapter} notify - Notify adapter for mid-run notices.
 */

/**
 * The Call Session (CONTEXT.md): one summarizer call's live execution
 * context, carried across every hop of the Narrative Chain. The session's
 * whole interface is its facts plus `runSeries` — one hop in, one Route
 * Series Result out. Route cycling, health buckets, and the Route Plan stay
 * with the Request Runner that builds the session.
 * @param {CallSessionFacts} facts
 * @returns {CallSessionFacts & { runSeries: (route: import('./call-profile.js').CallProfileRoute, hop: { routeLabel: string, maxRetries: number }) => Promise<RouteSeriesResult> }}
 */
export function createAttemptSession(facts) {
    return {
        ...facts,
        runSeries: (route, hop) => runSeriesForSession(facts, route, hop),
    };
}

/**
 * Run one connection route's retry series: repeated attempts with the repair
 * switch and retry waits until an attempt settles terminally or the retry
 * budget runs out. One hop of the Narrative Chain. The repair switch is
 * per hop: a fallback hop starts back on the base prompt.
 * @param {CallSessionFacts} facts - The session's call facts.
 * @param {import('./call-profile.js').CallProfileRoute} route - Resolved connection and timeout for this hop.
 * @param {{ routeLabel: string, maxRetries: number }} hop - Runner-derived route label and retry budget.
 * @returns {Promise<RouteSeriesResult>}
 */
async function runSeriesForSession(
    { prompt, repairPrompt, signal, profile, notify },
    route,
    { routeLabel, maxRetries },
) {
    /** @type {Error & { status?: number, response?: { status?: number } }} */
    let lastError = new Error('no error');
    let attempts = 0;
    let useRepairPrompt = false;
    let repairFeedback = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) {
            return { status: 'aborted', error: lastError, attempts };
        }
        attempts++;
        trace(`  ${routeLabel} attempt ${attempt} starting...`);
        if (attempt > 0) {
            debug(`${routeLabel} retry attempt ${attempt}/${maxRetries}`);
        }

        const attemptPromptText = buildAttemptPrompt(
            prompt,
            repairPrompt,
            useRepairPrompt,
            repairFeedback,
        );
        const attemptResult = await runLoggedAttempt({
            prompt: attemptPromptText,
            signal,
            attempt,
            profile,
            connection: route.connection,
            timeoutMs: route.timeoutMs,
            routeLabel,
            notify,
        });

        if (attemptResult.status === 'completed') {
            return { status: 'completed', text: attemptResult.text, attempts };
        }

        lastError = /** @type {Error} */ (attemptResult.error);

        if (attemptResult.status === 'aborted') {
            return { status: 'aborted', error: lastError, attempts };
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
            return settleStop(attemptResult, lastError, attempts);
        }

        if (shouldSwitchToRepairPrompt({ attemptResult, attempt, maxRetries, repairPrompt })) {
            useRepairPrompt = true;
            repairFeedback = attemptResult.repairFeedback || '';
        }

        await notifyRetryAndWait({ lastError, attempt, signal, maxRetries, notify });
    }
    return { status: 'failed', retryable: true, error: lastError, attempts };
}

/**
 * Map a terminally-settled attempt onto the series vocabulary: `failed`
 * carries its retryability, `rejected` the hygiene reason, and the rest are
 * bare error endings.
 * @param {AttemptResult} attemptResult
 * @param {Error} error
 * @param {number} attempts
 * @returns {RouteSeriesResult}
 */
function settleStop(attemptResult, error, attempts) {
    if (attemptResult.status === 'failed') {
        return { status: 'failed', retryable: attemptResult.retryable, error, attempts };
    }
    if (attemptResult.status === 'rejected') {
        return { status: 'rejected', reason: attemptResult.reason, error, attempts };
    }
    return { status: attemptResult.status, error, attempts };
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
 * Run one attempt and record its per-attempt transaction log; never throws.
 * Provider throws are classified onto the attempt vocabulary.
 * @param {object} p
 * @param {string} p.prompt - Fully substituted user prompt for this attempt.
 * @param {AbortSignal} p.signal - Abort signal for the request.
 * @param {number} p.attempt - Zero-based attempt index.
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch.
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route.
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds.
 * @param {string} p.routeLabel - Route label for structured logs.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for mid-run notices.
 * @returns {Promise<AttemptResult>}
 */
async function runLoggedAttempt({
    prompt,
    signal,
    attempt,
    profile,
    connection,
    timeoutMs,
    routeLabel,
    notify,
}) {
    const startedAt = Date.now();
    const logState = createAttemptLogState();
    /** @type {AttemptResult} */
    let attemptResult;
    try {
        attemptResult = await runAttempt({
            prompt,
            signal,
            profile,
            connection,
            timeoutMs,
            notify,
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
            cleanedResult: logState.cleanedResult,
            error: logState.error,
        });
    }
    return attemptResult;
}

/**
 * Run one summarizer request attempt through guard, send, and result
 * processing. Throws on provider errors; the series classifies them.
 * @param {object} p
 * @param {string} p.prompt - Fully substituted user prompt.
 * @param {AbortSignal} p.signal - Abort signal for the request.
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch.
 * @param {ExtensionSettings} p.connection - Resolved connection settings for this route.
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for mid-run notices.
 * @returns {Promise<AttemptResult>}
 */
async function runAttempt({ prompt, signal, profile, connection, timeoutMs, notify }) {
    // One read-through: the frozen Call Profile is the only source of the
    // system prompt; no helper receives it as a second, parallel fact.
    const systemPrompt = profile.policy.systemPrompt;
    const guardFailure = await getEasyContextGuardFailure({ prompt, profile, notify });
    if (guardFailure) {
        return guardFailure;
    }

    await traceSummarizerRequest({ connection, systemPrompt, prompt });
    const rawResult = await sendAttemptRequest({
        connection,
        systemPrompt,
        prompt,
        signal,
        timeoutMs,
    });
    trace('  sendSummarizerRequest returned:', rawResult?.substring?.(0, 50));
    return await processAttemptResult({ rawResult, prompt, profile, notify });
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
 * @param {AbortSignal} p.signal - Abort signal for the request
 * @param {number} p.timeoutMs - Attempt timeout in milliseconds
 * @returns {Promise<string>} Raw provider output
 */
async function sendAttemptRequest({ connection, systemPrompt, prompt, signal, timeoutMs }) {
    const timeoutRetryable = isCancellableConnection(connection);
    const abortContext = createAttemptAbortContext(signal, timeoutMs, timeoutRetryable);

    try {
        return await Promise.race([
            sendSummarizerRequest({
                settings: connection,
                systemPrompt,
                userPrompt: prompt,
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
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {import('./call-profile.js').CallProfile} p.profile - Call profile resolved at dispatch
 * @param {import('./notify.js').NotifyAdapter} p.notify
 * @returns {Promise<AttemptResult>}
 */
async function processAttemptResult({ rawResult, prompt, profile, notify }) {
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

    await recordSuccessfulSummarizerUsage({
        systemPrompt: profile.policy.systemPrompt,
        prompt,
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
 * @param {string} p.prompt - Fully substituted user prompt
 * @returns {Promise<void>}
 */
async function traceSummarizerRequest({ connection, systemPrompt, prompt }) {
    if (!isTraceEnabled()) {
        return;
    }

    const promptTokens = await countTextTokens(prompt);
    trace('  About to call sendSummarizerRequest with:', {
        connectionSource: connection.connectionSource,
        summarizerSystemPrompt: systemPrompt?.substring(0, 50),
        promptTokens: formatTokenCount(promptTokens),
    });
}

/**
 * Map a thrown provider error onto the attempt vocabulary.
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
 * Display duration is adapter policy. The wait stays in retry policy
 * (ADR-0019).
 * @param {object} p
 * @param {number} p.delay - Milliseconds to wait
 * @param {(line: string) => void} p.log - Structured log emitter (warn/info)
 * @param {string} p.logLine - Structured log message
 * @param {import('./notify.js').NotifyTransientEvent} p.event - Structured notify event
 * @param {AbortSignal} p.signal - Signal that cuts the wait short.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter threaded from the request series
 * @returns {Promise<void>}
 */
async function emitRetryEventAndWait({ delay, log, logLine, event, signal, notify }) {
    log(logLine);
    notify.transient(event);
    await sleepOrAbort(delay, signal);
}

/**
 * @param {object} p
 * @param {Error & { status?: number, response?: { status?: number } }} p.lastError - The error that triggered the retry.
 * @param {number} p.attempt - Zero-based attempt index.
 * @param {AbortSignal} p.signal - Signal that cuts the wait short.
 * @param {number} p.maxRetries - Maximum retry count for this route.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter threaded from the request series.
 * @returns {Promise<void>}
 */
async function notifyRetryAndWait({ lastError, attempt, signal, maxRetries, notify }) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';
    await emitRetryEventAndWait({
        delay,
        log: (line) => warn(line, lastError.message || lastError),
        logLine: `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        event: {
            kind: NOTIFY_EVENTS.RETRY_WAIT,
            attempt,
            delayMs: delay,
            maxRetries,
        },
        signal,
        notify,
    });
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
