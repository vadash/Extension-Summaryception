import { LOG_PREFIX, defaultSettings } from '../foundation/constants.js';
import {
    ConnectionError,
    resolveFallbackSummarizerConnectionSettings,
    resolveSummarizerConnectionSettings,
    sendSummarizerRequest,
} from './connectionutil.js';
import { getSettings, getPlayerName } from '../foundation/state.js';
import {
    debug,
    error as logError,
    info,
    isPromptInputLogEnabled,
    isPromptLogEnabled,
    isPromptOutputLogEnabled,
    isTraceEnabled,
    trace,
    warn,
} from '../foundation/logger.js';
import { RETRY_CONFIG, parseRetryAfter, isRetryableError } from '../foundation/retry.js';
import { cleanSummarizerOutput } from './prompts.js';
import { estimateSummarizerUsage, recordSummarizerUsage } from './summarizer-usage.js';
import { countTextTokens, formatTokenCount } from './token-count.js';

let currentAbortController = null;
const PRIMARY_HEALTH_BUCKETS = {
    layer0: 'layer0',
    l1plus: 'l1plus',
};
const primaryRetryExhaustedBuckets = new Set();

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
        debug('Abort signal sent.');
    }
}

/**
 * Call the configured summarizer backend with retry logic.
 * @param {string} storyTxt - The story text to summarize
 * @param {string} contextStr - The accumulated context string
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata] - Call metadata for debug usage logs
 * @returns {Promise<string>} The generated summary, or '' on failure/abort
 */
export async function callSummarizer(storyTxt, contextStr, metadata = {}) {
    trace('>>> ENTERING callSummarizer');
    await traceSummarizerInputTokens(storyTxt, contextStr);

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const promptConfig = resolveSummarizerPromptConfig(s, metadata);
    const prompt = buildSummarizerPrompt(promptConfig.userPromptTemplate, storyTxt, contextStr);
    const usageMetadata = await buildUsageMetadata(metadata, storyTxt);

    currentAbortController = new AbortController();

    try {
        return await runSummarizerAttempts({
            s,
            systemPrompt: promptConfig.systemPrompt,
            prompt,
            signal: currentAbortController.signal,
            metadata: usageMetadata,
        });
    } finally {
        currentAbortController = null;
    }
}

/**
 * Add usage-only details that should not affect prompt labels or routing.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @param {string} storyTxt - Source text being summarized
 * @returns {Promise<import('./summarizer-usage.js').SummarizerCallMetadata>}
 */
async function buildUsageMetadata(metadata = {}, storyTxt = '') {
    if (metadata.kind !== 'promotion') {
        return metadata;
    }

    const memoryTokens = await countTextTokens(storyTxt || '');
    return {
        ...metadata,
        memoryTokensBefore: memoryTokens.count,
        memoryTokensBeforeEstimated: memoryTokens.estimated,
    };
}

/**
 * Resolve the system and user prompt template for a summarizer call.
 * @param {ExtensionSettings} s - Settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @returns {{ systemPrompt: string, userPromptTemplate: string }}
 */
function resolveSummarizerPromptConfig(s, metadata = {}) {
    if (metadata.kind === 'promotion') {
        return {
            systemPrompt: getStringSetting(
                s.promotionSystemPrompt,
                defaultSettings.promotionSystemPrompt,
            ),
            userPromptTemplate: getStringSetting(
                s.promotionUserPrompt,
                defaultSettings.promotionUserPrompt,
            ),
        };
    }

    return {
        systemPrompt: getStringSetting(
            s.summarizerSystemPrompt,
            defaultSettings.summarizerSystemPrompt,
        ),
        userPromptTemplate: getStringSetting(
            s.summarizerUserPrompt,
            defaultSettings.summarizerUserPrompt,
        ),
    };
}

/**
 * Return a string setting while preserving intentionally empty strings.
 * @param {unknown} value - Candidate setting value
 * @param {string} fallback - Default value for malformed legacy settings
 * @returns {string}
 */
function getStringSetting(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}

/**
 * Build the configured user prompt with runtime substitutions.
 * @param {string} template - User prompt template
 * @param {string} storyTxt - Story text
 * @param {string} contextStr - Context text
 * @returns {string}
 */
function buildSummarizerPrompt(template, storyTxt, contextStr) {
    return template
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);
}

/**
 * Describe a summarizer request for prompt logs.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @returns {string}
 */
function describePromptLogCall(metadata = {}) {
    if (metadata.kind === 'layer0') {
        return `layer0 turns ${formatPromptLogRange(metadata.sourceRange)}`;
    }
    if (metadata.kind === 'promotion') {
        const sourceLayer = metadata.layerIndex ?? '?';
        const destLayer = typeof metadata.layerIndex === 'number' ? metadata.layerIndex + 1 : '?';
        const count = formatPromptLogCount(metadata.mergedSnippetCount, 'snippet');
        return `promotion L${sourceLayer}->L${destLayer} (${count})`;
    }
    if (metadata.kind === 'regenerate') {
        return `regenerate turns ${formatPromptLogRange(metadata.sourceRange)}`;
    }
    return metadata.kind || 'summarizer';
}

/**
 * Format a source range for prompt logs.
 * @param {[number, number] | undefined} range - Source range
 * @returns {string}
 */
function formatPromptLogRange(range) {
    if (!Array.isArray(range) || range.length < 2) {
        return '?';
    }
    return `${range[0]}-${range[1]}`;
}

/**
 * Format a singular/plural count for prompt logs.
 * @param {number | undefined} count - Count value
 * @param {string} singular - Singular label
 * @returns {string}
 */
function formatPromptLogCount(count, singular) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return `? ${singular}s`;
    }
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * Run retry attempts until success, abort, non-retryable error, or exhaustion.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {AbortSignal} p.signal - Abort signal
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {Promise<string>} Summary text, or '' on failure
 */
async function runSummarizerAttempts({ s, systemPrompt, prompt, signal, metadata }) {
    const healthBucket = getPrimaryHealthBucket(metadata);
    const fallbackSettings = resolveFallbackSummarizerConnectionSettings(s, metadata);
    const primaryMaxRetries =
        fallbackSettings && primaryRetryExhaustedBuckets.has(healthBucket)
            ? 0
            : RETRY_CONFIG.maxRetries;

    if (primaryMaxRetries === 0) {
        debug(
            `Primary summarizer previously exhausted retries for ${healthBucket}; ` +
                'probing once before fallback.',
        );
    }

    const primary = await runSummarizerAttemptSeries({
        s,
        systemPrompt,
        prompt,
        signal,
        metadata,
        routeLabel: 'primary',
        maxRetries: primaryMaxRetries,
    });

    if (primary.status === 'success') {
        primaryRetryExhaustedBuckets.delete(healthBucket);
        return primary.result;
    }
    if (primary.status === 'aborted') {
        return abortWithToast();
    }

    if (primary.retryable && primary.retriesExhausted) {
        primaryRetryExhaustedBuckets.add(healthBucket);
    }

    if (primary.retryable && fallbackSettings) {
        info(
            `Primary summarizer failed after retryable errors; trying fallback ` +
                `(${fallbackSettings.connectionSource}).`,
        );
        const fallback = await runSummarizerAttemptSeries({
            s,
            systemPrompt,
            prompt,
            signal,
            metadata: { ...metadata, useFallback: true },
            routeLabel: 'fallback',
            maxRetries: RETRY_CONFIG.maxRetries,
        });

        if (fallback.status === 'success') {
            return fallback.result;
        }
        if (fallback.status === 'aborted') {
            return abortWithToast();
        }
        return failSummarization(fallback.error, {
            retriesExhausted: fallback.retryable,
        });
    }

    return failSummarization(primary.error, {
        retriesExhausted: primary.retryable,
    });
}

/**
 * Split primary health tracking by prompt family so Layer 0 and L1+ failures
 * do not influence each other.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function getPrimaryHealthBucket(metadata = {}) {
    return metadata.kind === 'promotion'
        ? PRIMARY_HEALTH_BUCKETS.l1plus
        : PRIMARY_HEALTH_BUCKETS.layer0;
}

/**
 * Run retry attempts for one resolved connection route.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {AbortSignal} p.signal - Abort signal
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @param {string} p.routeLabel - Human-readable route label for trace logs
 * @param {number} p.maxRetries - Maximum retry count for this route
 * @returns {Promise<{ status: 'success', result: string, error: Error, retryable: false, retriesExhausted: false } | { status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean } | { status: 'aborted', result: string, error: Error, retryable: false, retriesExhausted: false }>}
 */
async function runSummarizerAttemptSeries({
    s,
    systemPrompt,
    prompt,
    signal,
    metadata,
    routeLabel,
    maxRetries,
}) {
    /** @type {Error & { status?: number, response?: { status?: number } }} */
    let lastError = new Error('no error');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) {
            return {
                status: 'aborted',
                result: '',
                error: lastError,
                retryable: false,
                retriesExhausted: false,
            };
        }

        const attemptResult = await executeSummarizerAttempt({
            s,
            systemPrompt,
            prompt,
            signal,
            attempt,
            metadata,
            routeLabel,
            maxRetries,
        });

        if (attemptResult.success) {
            return {
                status: 'success',
                result: attemptResult.result,
                error: attemptResult.error,
                retryable: false,
                retriesExhausted: false,
            };
        }

        lastError = attemptResult.error;

        if (attemptResult.aborted) {
            return {
                status: 'aborted',
                result: '',
                error: lastError,
                retryable: false,
                retriesExhausted: false,
            };
        }

        if (shouldStopRetrying(attemptResult, attempt, maxRetries)) {
            return {
                status: 'failed',
                result: '',
                error: lastError,
                retryable: attemptResult.shouldRetry,
                retriesExhausted: attemptResult.shouldRetry && attempt >= maxRetries,
            };
        }

        await notifyRetryAndWait(lastError, attempt, signal, maxRetries);
    }

    return {
        status: 'failed',
        result: '',
        error: lastError,
        retryable: true,
        retriesExhausted: true,
    };
}

/**
 * Run a single summarizer attempt and classify the outcome.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - The fully substituted prompt
 * @param {AbortSignal} p.signal
 * @param {number} p.attempt - Zero-based attempt index
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @param {string} p.routeLabel - Human-readable route label for trace logs
 * @param {number} p.maxRetries - Maximum retry count for this route
 * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean }>}
 */
async function executeSummarizerAttempt({
    s,
    systemPrompt,
    prompt,
    signal,
    attempt,
    metadata,
    routeLabel,
    maxRetries,
}) {
    trace(`  ${routeLabel} attempt ${attempt} starting...`);
    const startedAt = Date.now();
    let rawResult = '';
    let cleanedResult = '';
    let usage = null;
    let attemptError = null;
    let status = 'failed';

    try {
        if (attempt > 0) {
            debug(`${routeLabel} retry attempt ${attempt}/${maxRetries}`);
        }

        await traceSummarizerRequest({ s, systemPrompt, prompt, metadata });

        const abortContext = createAttemptAbortContext(signal, 120000);

        try {
            rawResult = await Promise.race([
                sendSummarizerRequest(s, systemPrompt, prompt, abortContext.signal, metadata),
                abortContext.promise,
            ]);
        } finally {
            abortContext.cleanup();
        }

        trace('  sendSummarizerRequest returned:', rawResult?.substring?.(0, 50));

        cleanedResult = cleanSummarizerOutput((rawResult || '').trim());

        if (!cleanedResult) {
            attemptError = new Error('Empty response from summarizer');
            status = 'empty';
            debug('Empty response from LLM, treating as retryable');
            return buildAttemptFailure(attemptError, true);
        }

        usage = await logSuccessfulUsage({
            systemPrompt,
            prompt,
            summary: cleanedResult,
            metadata,
        });
        status = 'success';
        trace('<<< EXITING callSummarizer WITH SUCCESS');
        return {
            success: true,
            result: cleanedResult,
            error: new Error('no error'),
            aborted: false,
            shouldRetry: false,
        };
    } catch (err) {
        const result = classifyAttemptError(err, signal);
        attemptError = result.error;
        status = result.aborted ? 'aborted' : 'failed';
        return result;
    } finally {
        logLlmAttemptTransaction({
            label: describePromptLogCall(metadata),
            routeLabel,
            attempt,
            status,
            durationMs: Date.now() - startedAt,
            systemPrompt,
            prompt,
            cleanedResult,
            metadata,
            usage,
            error: attemptError,
        });
    }
}

/**
 * Trace token counts for summarizer input text.
 * @param {string} storyTxt - Story text
 * @param {string} contextStr - Context text
 * @returns {Promise<void>}
 */
async function traceSummarizerInputTokens(storyTxt, contextStr) {
    if (!isTraceEnabled()) {
        return;
    }

    const [storyTokens, contextTokens] = await Promise.all([
        countTextTokens(storyTxt || ''),
        countTextTokens(contextStr || ''),
    ]);

    trace('  storyTxt tokens:', formatTokenCount(storyTokens));
    trace('  contextStr tokens:', formatTokenCount(contextTokens));
}

/**
 * Trace the summarizer request metadata.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {Promise<void>}
 */
async function traceSummarizerRequest({ s, systemPrompt, prompt, metadata }) {
    if (!isTraceEnabled()) {
        return;
    }

    const promptTokens = await countTextTokens(prompt);
    const effectiveSettings = resolveSummarizerConnectionSettings(s, metadata);
    trace('  About to call sendSummarizerRequest with:', {
        connectionSource: effectiveSettings.connectionSource,
        summarizerSystemPrompt: systemPrompt?.substring(0, 50),
        promptTokens: formatTokenCount(promptTokens),
    });
}

/**
 * Estimate and record usage for a successful summarizer response.
 * @param {object} p
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {string} p.summary - Cleaned summarizer response
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {Promise<import('./summarizer-usage.js').SummarizerTokenUsage>}
 */
async function logSuccessfulUsage({ systemPrompt, prompt, summary, metadata }) {
    const usage = await estimateSummarizerUsage(systemPrompt, prompt, summary);
    recordSummarizerUsage({
        metadata,
        ...usage,
    });
    return usage;
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
        logError('Non-retryable error:', error);
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
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {boolean}
 */
function shouldStopRetrying(attemptResult, attempt, maxRetries) {
    if (!attemptResult.shouldRetry) {
        trace('  ERROR IS NON-RETRYABLE, BREAKING');
        return true;
    }

    if (attempt >= maxRetries) {
        trace('  MAX RETRIES EXHAUSTED');
        if (maxRetries === 0) {
            debug('Primary probe failed; trying fallback without additional retries.');
        } else {
            logError(`All ${maxRetries} retries exhausted.`);
        }
        return true;
    }

    return false;
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
            const error = new ConnectionError('Request timed out after 120s', {
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
 * Notify the user about a retry attempt and wait the computed delay.
 * @param {Error} lastError - The error that triggered the retry
 * @param {number} attempt - Zero-based attempt index
 * @param {AbortSignal} signal
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {Promise<void>}
 */
async function notifyRetryAndWait(
    /** @type {Error & { status?: number, response?: { status?: number } }} */ lastError,
    attempt,
    signal,
    maxRetries,
) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';

    warn(
        `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        lastError.message || lastError,
    );

    toastr.warning(
        `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${maxRetries})`,
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
    debug('Summarization aborted by user.');
    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
    return '';
}

/**
 * Toast and log a terminal summarization failure.
 * @param {Error & { status?: number, response?: { status?: number } }} lastError
 * @returns {string} Always ''
 */
function failSummarization(lastError, { retriesExhausted = true } = {}) {
    const status = lastError?.status || lastError?.response?.status || '';
    const retryText = retriesExhausted ? ` after ${RETRY_CONFIG.maxRetries} retries` : '';
    logError(`Summarization failed${retryText}:`, lastError);
    toastr.error(
        `Summarization failed${retryText}${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
        'Summaryception',
        { timeOut: 8000 },
    );
    trace('<<< EXITING callSummarizer WITH FAILURE');
    return '';
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
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @param {import('./summarizer-usage.js').SummarizerTokenUsage | null} p.usage - Token usage
 * @param {Error | null} p.error - Attempt error
 * @returns {void}
 */
function logLlmAttemptTransaction({
    label,
    routeLabel,
    attempt,
    status,
    durationMs,
    systemPrompt,
    prompt,
    cleanedResult,
    metadata,
    usage,
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
        console.log('Metadata', {
            route: routeLabel,
            attempt: attempt + 1,
            status,
            durationMs,
            metadata,
            usage,
        });
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
    if (!error) {
        return null;
    }
    const e =
        /** @type {Error & { status?: number, statusCode?: number, retryable?: boolean, response?: { status?: number } }} */ (
            error
        );
    return {
        name: e.name || 'Error',
        message: e.message || String(e),
        status: e.status || e.statusCode || e.response?.status || null,
        retryable: typeof e.retryable === 'boolean' ? e.retryable : null,
    };
}
