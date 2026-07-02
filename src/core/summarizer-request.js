import { LOG_PREFIX } from '../foundation/constants.js';
import { sendSummarizerRequest } from './connectionutil.js';
import { getSettings, getPlayerName } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { RETRY_CONFIG, parseRetryAfter, isRetryableError } from '../foundation/retry.js';
import {
    snapshotPromptToggles,
    disableAllPromptToggles,
    restorePromptToggles,
    cleanSummarizerOutput,
} from './prompts.js';

let currentAbortController = null;

/**
 * Check whether an abort controller is active.
 * @returns {boolean}
 */
export function hasActiveAbortController() {
    return Boolean(currentAbortController);
}

/**
 * Abort the in-flight summarizer request.
 * @returns {void}
 */
export function abortCurrentSummarizerRequest() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
}

/**
 * Call the configured summarizer backend with retry logic.
 * @param {string} storyTxt - The story text to summarize
 * @param {string} contextStr - The accumulated context string
 * @returns {Promise<string>} The generated summary, or '' on failure/abort
 */
export async function callSummarizer(storyTxt, contextStr) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const prompt = buildSummarizerPrompt(s, storyTxt, contextStr);

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const promptState = preparePromptToggles(s);
    currentAbortController = new AbortController();

    try {
        return await runSummarizerAttempts({
            s,
            prompt,
            signal: currentAbortController.signal,
        });
    } finally {
        currentAbortController = null;
        restorePromptState(promptState);
    }
}

/**
 * Build the configured user prompt with runtime substitutions.
 * @param {object} s - Settings
 * @param {string} storyTxt - Story text
 * @param {string} contextStr - Context text
 * @returns {string}
 */
function buildSummarizerPrompt(s, storyTxt, contextStr) {
    return s.summarizerUserPrompt
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);
}

/**
 * Disable default prompt toggles while using the active SillyTavern connection.
 * @param {object} s - Settings
 * @returns {{ isDefaultMode: boolean, snapshot: unknown }}
 */
function preparePromptToggles(s) {
    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) {
        disableAllPromptToggles();
    }
    return { isDefaultMode, snapshot };
}

/**
 * Restore prompt toggles after a summarizer call.
 * @param {{ isDefaultMode: boolean, snapshot: unknown }} promptState
 * @returns {void}
 */
function restorePromptState(promptState) {
    if (promptState.isDefaultMode && promptState.snapshot) {
        restorePromptToggles(promptState.snapshot);
    }
}

/**
 * Run retry attempts until success, abort, non-retryable error, or exhaustion.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {AbortSignal} p.signal - Abort signal
 * @returns {Promise<string>} Summary text, or '' on failure
 */
async function runSummarizerAttempts({ s, prompt, signal }) {
    /** @type {Error & { status?: number, response?: { status?: number } }} */
    let lastError = new Error('no error');

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        if (signal.aborted) {
            return abortWithToast();
        }

        const attemptResult = await executeSummarizerAttempt({ s, prompt, signal, attempt });

        if (attemptResult.success) {
            return attemptResult.result;
        }

        lastError = attemptResult.error;

        if (attemptResult.aborted) {
            return abortWithToast();
        }

        if (shouldStopRetrying(attemptResult, attempt)) {
            return failSummarization(lastError);
        }

        await notifyRetryAndWait(lastError, attempt, signal);
    }

    return failSummarization(lastError);
}

/**
 * Run a single summarizer attempt and classify the outcome.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.prompt - The fully substituted prompt
 * @param {AbortSignal} p.signal
 * @param {number} p.attempt - Zero-based attempt index
 * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean }>}
 */
async function executeSummarizerAttempt({ s, prompt, signal, attempt }) {
    trace(`  Attempt ${attempt} starting...`);

    try {
        if (attempt > 0) {
            log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
        }

        trace('  About to call sendSummarizerRequest with:', {
            connectionSource: s.connectionSource,
            summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
            promptLength: prompt.length,
        });

        const result = await Promise.race([
            sendSummarizerRequest(s, s.summarizerSystemPrompt, prompt),
            makeTimeoutRace(signal, 120000),
        ]);

        trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

        let trimmed = (result || '').trim();
        trimmed = cleanSummarizerOutput(trimmed);

        if (!trimmed) {
            log('Empty response from LLM, treating as retryable');
            return buildAttemptFailure(new Error('Empty response from summarizer'), true);
        }

        log('Result:', trimmed);
        trace('<<< EXITING callSummarizer WITH SUCCESS');
        return {
            success: true,
            result: trimmed,
            error: new Error('no error'),
            aborted: false,
            shouldRetry: false,
        };
    } catch (err) {
        return classifyAttemptError(err, signal);
    }
}

/**
 * Classify an exception from a summarizer attempt.
 * @param {unknown} err - Thrown error
 * @param {AbortSignal} signal - Abort signal
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean }}
 */
function classifyAttemptError(err, signal) {
    const error =
        /** @type {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} */ (
            err
        );
    trace('  Caught error on attempt:', {
        name: error?.name,
        message: error?.message,
        retryable: error?.retryable,
    });

    if (signal.aborted || error.message === 'Aborted by user') {
        return { success: false, result: '', error, aborted: true, shouldRetry: false };
    }

    const shouldRetry = isRetryableError(error);
    if (!shouldRetry) {
        console.error(LOG_PREFIX, 'Non-retryable error:', error);
    }

    return buildAttemptFailure(error, shouldRetry);
}

/**
 * Build a failed attempt result.
 * @param {Error} error - Attempt error
 * @param {boolean} shouldRetry - Whether retry should continue
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean }}
 */
function buildAttemptFailure(error, shouldRetry) {
    return {
        success: false,
        result: '',
        error,
        aborted: false,
        shouldRetry,
    };
}

/**
 * Decide whether retry processing should stop.
 * @param {{ shouldRetry: boolean }} attemptResult - Attempt result
 * @param {number} attempt - Zero-based attempt index
 * @returns {boolean}
 */
function shouldStopRetrying(attemptResult, attempt) {
    if (!attemptResult.shouldRetry) {
        trace('  ERROR IS NON-RETRYABLE, BREAKING');
        return true;
    }

    if (attempt >= RETRY_CONFIG.maxRetries) {
        trace('  MAX RETRIES EXHAUSTED');
        console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
        return true;
    }

    return false;
}

/**
 * Build a promise that rejects on abort or after a timeout.
 * @param {AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<never>}
 */
function makeTimeoutRace(signal, timeoutMs) {
    return new Promise((_, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Request timed out after 120s')),
            timeoutMs,
        );
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted by user'));
        });
    });
}

/**
 * Notify the user about a retry attempt and wait the computed delay.
 * @param {Error} lastError - The error that triggered the retry
 * @param {number} attempt - Zero-based attempt index
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function notifyRetryAndWait(
    /** @type {Error & { status?: number, response?: { status?: number } }} */ lastError,
    attempt,
    signal,
) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';

    console.warn(
        LOG_PREFIX,
        `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        lastError.message || lastError,
    );

    toastr.warning(
        `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
        'Summaryception',
        { timeOut: delay },
    );

    await sleepUntilOrAborted(delay, signal);
}

/**
 * Compute the retry delay for a given attempt, honoring Retry-After headers.
 * @param {Error} err - The error from the failed attempt
 * @param {number} attempt - Zero-based attempt index
 * @returns {number} Delay in milliseconds
 */
function computeRetryDelay(err, attempt) {
    const retryAfterMs = parseRetryAfter(err);
    if (retryAfterMs) {
        return Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
    }
    const exponentialDelay =
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
    return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
}

/**
 * Wait for a delay, resolving early if the signal is aborted.
 * @param {number} delay - Milliseconds to wait
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function sleepUntilOrAborted(delay, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Log and toast an abort and return the sentinel '' value.
 * @returns {string} Always ''
 */
function abortWithToast() {
    log('Summarization aborted by user.');
    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
    return '';
}

/**
 * Toast and log a terminal summarization failure.
 * @param {Error & { status?: number, response?: { status?: number } }} lastError
 * @returns {string} Always ''
 */
function failSummarization(lastError) {
    const status = lastError?.status || lastError?.response?.status || '';
    console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
    toastr.error(
        `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
        'Summaryception',
        { timeOut: 8000 },
    );
    trace('<<< EXITING callSummarizer WITH FAILURE');
    return '';
}
