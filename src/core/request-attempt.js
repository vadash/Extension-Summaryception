import { TOAST_TITLE, UI_MODES } from '../foundation/constants.js';
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
    resolveSummarizerConnectionSettings,
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    ROUTE_CYCLE_RETRY_ATTEMPT,
    classifyAttemptRetryStatus,
    computeRetryDelay,
} from './request-retry-policy.js';
import {
    processSummarizerResponse,
    recordSuccessfulSummarizerUsage,
} from './summarizer-pipeline.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import { insertBeforeTrigger, EXECUTION_TRIGGER_L0 } from '../foundation/prompt-parts.js';
import { describePromptLogCall } from './request-attempt-log.js';

/**
 * Append repair feedback before the L0 execution trigger.
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
 *
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

async function getEasyContextGuardFailure({ settings, systemPrompt, prompt, metadata }) {
    const guard = await checkEasyContextGuard(settings, systemPrompt, prompt, metadata);
    if (guard.ok) {
        return null;
    }

    const guardError = buildEasyContextGuardError(guard, metadata);
    warn(guardError.message);
    toastr.error(guardError.message, TOAST_TITLE, { timeOut: 10000 });
    return buildAttemptFailure(guardError, false, 'easy-context-guard');
}

async function sendAttemptRequest({ settings, systemPrompt, prompt, signal, metadata, timeoutMs }) {
    const abortContext = createAttemptAbortContext(signal, timeoutMs);

    try {
        return await Promise.race([
            sendSummarizerRequest({
                settings,
                systemPrompt,
                userPrompt: prompt,
                signal: abortContext.signal,
                metadata,
            }),
            abortContext.promise,
        ]);
    } finally {
        abortContext.cleanup();
    }
}

async function processAttemptResult({ rawResult, settings, systemPrompt, prompt, metadata }) {
    const processed = await processSummarizerResponse(rawResult, settings, metadata);
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
        metadata,
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
 * Trace the summarizer request metadata.
 * @param {object} p
 * @param {ExtensionSettings} p.settings - Settings
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {Promise<void>}
 */
async function traceSummarizerRequest({ settings, systemPrompt, prompt, metadata }) {
    if (!isTraceEnabled()) {
        return;
    }

    const promptTokens = await countTextTokens(prompt);
    const effectiveSettings = resolveSummarizerConnectionSettings(settings, metadata);
    trace('  About to call sendSummarizerRequest with:', {
        connectionSource: effectiveSettings.connectionSource,
        summarizerSystemPrompt: systemPrompt?.substring(0, 50),
        promptTokens: formatTokenCount(promptTokens),
    });
}

/**
 * Classify an exception from a summarizer attempt.
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
 * Build a failed attempt result.
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
 * @returns {{ signal: AbortSignal, promise: Promise<never>, cleanup: () => void }}
 */
function createAttemptAbortContext(userSignal, timeoutMs) {
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
                retryable: true,
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
 * Log the report line, toast a warning lasting the delay, then wait it out (abort cuts it short).
 * @param {object} p
 * @param {number} p.delay - Milliseconds to wait
 * @param {(line: string) => void} p.log - Structured log emitter (warn/info)
 * @param {string} p.logLine - Structured log message
 * @param {string} p.toastLine - Toast message
 * @param {AbortSignal} p.signal
 * @returns {Promise<void>}
 */
async function notifyAndWaitDelay({ delay, log, logLine, toastLine, signal }) {
    log(logLine);
    toastr.warning(toastLine, TOAST_TITLE, { timeOut: delay });
    await sleepOrAbort(delay, signal);
}

/**
 * Notify the user about a retry attempt and wait the computed delay.
 * @param {Error} lastError - The error that triggered the retry
 * @param {number} attempt - Zero-based attempt index
 * @param {AbortSignal} signal
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {Promise<void>}
 */
export async function notifyRetryAndWait(
    /** @type {Error & { status?: number, response?: { status?: number } }} */ lastError,
    attempt,
    signal,
    maxRetries,
) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';
    await notifyAndWaitDelay({
        delay,
        log: (line) => warn(line, lastError.message || lastError),
        logLine: `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        toastLine: `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${maxRetries})`,
        signal,
    });
}

/**
 * Notify the user that both routes failed, then wait before restarting from primary.
 * @param {object} p
 * @param {string} p.healthBucket
 * @param {AbortSignal} p.signal
 * @returns {Promise<void>}
 */
export async function notifyRouteCycleFailedAndWait({ healthBucket, signal }) {
    const delay = computeRetryDelay(new Error('Both routes failed'), ROUTE_CYCLE_RETRY_ATTEMPT);
    const delaySec = (delay / 1000).toFixed(1);
    await notifyAndWaitDelay({
        delay,
        log: info,
        logLine:
            `Both primary and fallback exhausted for ${healthBucket}; ` +
            `resetting health state and retrying primary in ${delaySec}s.`,
        toastLine: `Both summarizer routes failed. Retrying primary in ${delaySec}s...`,
        signal,
    });
}

async function checkEasyContextGuard(settings, systemPrompt, prompt, metadata = {}) {
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
        label: describePromptLogCall(metadata),
    };
}

function buildEasyContextGuardError(guard, metadata = {}) {
    const label = guard.label || describePromptLogCall(metadata);
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
