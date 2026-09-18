import { NOTIFY_EVENTS, UI_MODES } from '../foundation/constants.js';
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
    ROUTE_CYCLE_RETRY_ATTEMPT,
    classifyAttemptRetryStatus,
    computeRetryDelay,
} from './request-retry-policy.js';
import { processSummarizerResponse } from './summarizer-output.js';
import { recordSuccessfulSummarizerUsage } from './summarizer-pipeline.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import { insertBeforeTrigger, EXECUTION_TRIGGER_L0 } from '../foundation/prompt-parts.js';

/**
 * @param {string} prompt
 * @param {string} repairFeedback
 * @returns {string}
 */
export function appendRepairFeedback(prompt, repairFeedback) {
    const feedback = String(repairFeedback || '').trim();
    if (!feedback) {
        return prompt;
    }
    return insertBeforeTrigger(prompt, feedback, EXECUTION_TRIGGER_L0);
}

/**
 * Run one summarizer request attempt through guard, send, and result processing.
 * @param {object} params - Attempt inputs for the route state machine.
 * @param {ExtensionSettings} params.settings - Active settings.
 * @param {string} params.systemPrompt - Fully substituted system prompt.
 * @param {string} params.prompt - Fully substituted user prompt.
 * @param {AbortSignal} params.signal - Abort signal for the request.
 * @param {number} params.attempt - Zero-based attempt index.
 * @param {import('./call-profile.js').CallProfile} params.profile - Call profile resolved at dispatch.
 * @param {ExtensionSettings} params.connection - Resolved connection settings for this route.
 * @param {boolean} [params.layer0Repair] - Whether this attempt re-runs a rejected Layer 0 output.
 * @param {string} [params.repairFeedback] - Diagnostics appended to the repair prompt.
 * @param {import('./notify.js').NotifyAdapter} params.notify - Notify adapter for mid-run notices.
 * @param {string} params.routeLabel - Route label for structured logs.
 * @param {number} params.maxRetries - Retry budget for this route.
 * @param {number} params.timeoutMs - Attempt timeout in milliseconds.
 * @returns {Promise<object>} Attempt outcome with status, result, error, and retry flags.
 */
export async function runSingleAttempt(params) {
    if (params.attempt > 0) {
        debug(`${params.routeLabel} retry attempt ${params.attempt}/${params.maxRetries}`);
    }

    const guardFailure = await getEasyContextGuardFailure(params);
    if (guardFailure) {
        return guardFailure;
    }

    await traceSummarizerRequest(params);
    const rawResult = await sendAttemptRequest(params);
    trace('  sendSummarizerRequest returned:', rawResult?.substring?.(0, 50));
    return await processAttemptResult({ ...params, rawResult });
}

async function getEasyContextGuardFailure({ settings, systemPrompt, prompt, profile, notify }) {
    const guard = await checkEasyContextGuard(settings, systemPrompt, prompt, profile);
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
    return buildAttemptFailure(guardError, false, 'easy-context-guard');
}

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

async function processAttemptResult({
    rawResult,
    settings,
    systemPrompt,
    prompt,
    profile,
    notify,
}) {
    const processed = await processSummarizerResponse(rawResult, settings, profile, notify);
    if (processed.status !== 'success') {
        logProcessedAttemptFailure(processed.status);
        return {
            ...buildAttemptFailure(processed.error, true, processed.status),
            cleanedResult: processed.text,
            repairFeedback: processed.repairFeedback,
        };
    }

    await recordSuccessfulSummarizerUsage({
        systemPrompt,
        prompt,
        summary: processed.text,
        profile,
    });
    trace('<<< EXITING callSummarizer WITH SUCCESS');
    return buildAttemptSuccess(processed.text);
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

function buildAttemptSuccess(result) {
    return {
        success: true,
        result,
        error: new Error('no error'),
        aborted: false,
        shouldRetry: false,
        hardFailover: false,
        failureStatus: '',
        cleanedResult: result,
    };
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
 * @param {unknown} err - Thrown error
 * @param {AbortSignal} signal - Abort signal
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean, failureStatus?: string }}
 */
export function classifyAttemptError(err, signal) {
    const error =
        /** @type {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} */ (
            err
        );
    trace('  Caught error on attempt:', serializeError(error));

    const retryStatus = classifyAttemptRetryStatus(error, signal.aborted);
    if (retryStatus.aborted) {
        return {
            success: false,
            result: '',
            error,
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'aborted',
        };
    }

    if (retryStatus.hardFailover) {
        info('Hard network failure detected; skipping retries for this route.', error.message);
        return {
            success: false,
            result: '',
            error,
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
            failureStatus: 'hard-failover',
        };
    }

    if (!retryStatus.shouldRetry) {
        logError('Non-retryable error:', error);
    }

    return buildAttemptFailure(error, retryStatus.shouldRetry, retryStatus.failureStatus);
}

/**
 * @param {Error} error - Attempt error
 * @param {boolean} shouldRetry - Whether retry should continue
 * @param {string} [failureStatus] - Attempt failure classification
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean, failureStatus?: string }}
 */
function buildAttemptFailure(error, shouldRetry, failureStatus = 'failed') {
    return {
        success: false,
        result: '',
        error,
        aborted: false,
        shouldRetry,
        hardFailover: false,
        failureStatus,
    };
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
 * (ADR-0004).
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
export async function notifyRetryAndWait({ lastError, attempt, signal, maxRetries, notify }) {
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
 * Notify the user that both routes failed, then wait before restarting from primary.
 * @param {object} p
 * @param {string} p.healthBucket
 * @param {AbortSignal} p.signal
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter threaded from the request series
 * @returns {Promise<void>}
 */
export async function notifyRouteCycleFailedAndWait({ healthBucket, signal, notify }) {
    const delay = computeRetryDelay(new Error('Both routes failed'), ROUTE_CYCLE_RETRY_ATTEMPT);
    const delaySec = (delay / 1000).toFixed(1);
    await emitRetryEventAndWait({
        delay,
        log: info,
        logLine:
            `Both primary and fallback exhausted for ${healthBucket}; ` +
            `resetting health state and retrying primary in ${delaySec}s.`,
        event: {
            kind: NOTIFY_EVENTS.ROUTE_CYCLE_WAIT,
            delayMs: delay,
        },
        signal,
        notify,
    });
}

/**
 * @param {ExtensionSettings} settings
 * @param {string} systemPrompt
 * @param {string} prompt - Fully substituted user prompt
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @returns {Promise<{ ok: true } | { ok: false, limit: number, tokens: { count: number, estimated: boolean }, label: string }>}
 */
async function checkEasyContextGuard(settings, systemPrompt, prompt, profile) {
    if (settings.uiMode !== UI_MODES.EASY) {
        return { ok: true };
    }

    const limit = Number(settings.advancedModelContext);
    if (!Number.isFinite(limit) || limit <= 0) {
        return { ok: true };
    }

    const requestText = `${systemPrompt || ''}\n\n${prompt || ''}`;
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
