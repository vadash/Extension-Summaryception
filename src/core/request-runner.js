import { LOG_PREFIX } from '../foundation/constants.js';
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
import { RETRY_CONFIG, isRetryableError, parseRetryAfter } from '../foundation/retry.js';
import {
    ConnectionError,
    resolveFallbackSummarizerConnectionSettings,
    resolveSummarizerConnectionSettings,
    sendSummarizerRequest,
} from './connectionutil.js';
import {
    processSummarizerResponse,
    recordSuccessfulSummarizerUsage,
} from './summarizer-pipeline.js';
import { countTextTokens, formatTokenCount } from './token-count.js';

const PRIMARY_HEALTH_BUCKETS = {
    layer0: 'layer0',
    l1plus: 'l1plus',
};
const ROUTE_CYCLE_RETRY_ATTEMPT = RETRY_CONFIG.maxRetries;

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
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
     * @returns {Promise<string>} Summary text, or '' on failure
     */
    async run({ settings, systemPrompt, prompt, signal, metadata }) {
        const healthBucket = getPrimaryHealthBucket(metadata);
        const fallbackSettings = resolveFallbackSummarizerConnectionSettings(settings, metadata);

        while (true) {
            if (signal.aborted) {
                return abortWithToast();
            }

            const primaryMaxRetries =
                fallbackSettings && this.primaryRetryExhaustedBuckets.has(healthBucket)
                    ? 0
                    : RETRY_CONFIG.maxRetries;

            if (primaryMaxRetries === 0) {
                debug(
                    `Primary summarizer previously exhausted retries for ${healthBucket}; ` +
                        'probing once before fallback.',
                );
            }

            const primary = await this.runAttemptSeries({
                settings,
                systemPrompt,
                prompt,
                signal,
                metadata,
                routeLabel: 'primary',
                maxRetries: primaryMaxRetries,
            });

            if (primary.status === 'success') {
                this.primaryRetryExhaustedBuckets.delete(healthBucket);
                return primary.result;
            }
            if (primary.status === 'aborted') {
                return abortWithToast();
            }

            if (primary.retryable && primary.retriesExhausted) {
                this.primaryRetryExhaustedBuckets.add(healthBucket);
            }

            const shouldTryFallback =
                fallbackSettings && (primary.retryable || primary.hardFailover);

            if (shouldTryFallback) {
                info(
                    `Primary summarizer failed${primary.hardFailover ? ' (hard network failure)' : ' after retryable errors'}; trying fallback ` +
                        `(${fallbackSettings.connectionSource}).`,
                );
                const fallback = await this.runAttemptSeries({
                    settings,
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
                await notifyRouteCycleFailedAndWait({ healthBucket, signal });
                this.primaryRetryExhaustedBuckets.delete(healthBucket);
                continue;
            }

            if (!primary.retryable) {
                return failSummarization(primary.error, {
                    retriesExhausted: false,
                });
            }

            // Primary exhausted, no fallback configured - loop and retry.
            this.primaryRetryExhaustedBuckets.delete(healthBucket);
        }
    }

    /**
     * Run retry attempts for one resolved connection route.
     * @param {object} p
     * @param {ExtensionSettings} p.settings - Settings
     * @param {string} p.systemPrompt - System prompt sent to the summarizer
     * @param {string} p.prompt - Fully substituted user prompt
     * @param {AbortSignal} p.signal - Abort signal
     * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
     * @param {string} p.routeLabel - Human-readable route label for trace logs
     * @param {number} p.maxRetries - Maximum retry count for this route
     * @returns {Promise<{ status: 'success', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false } | { status: 'failed', result: string, error: Error, retryable: boolean, retriesExhausted: boolean, hardFailover: boolean } | { status: 'aborted', result: string, error: Error, retryable: false, retriesExhausted: false, hardFailover: false }>}
     */
    async runAttemptSeries({
        settings,
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
                    hardFailover: false,
                };
            }

            const timeoutMs = computeAttemptTimeoutMs(metadata, attempt);
            const attemptResult = await this.executeAttempt({
                settings,
                systemPrompt,
                prompt,
                signal,
                attempt,
                metadata,
                routeLabel,
                maxRetries,
                timeoutMs,
            });

            if (attemptResult.success) {
                return {
                    status: 'success',
                    result: attemptResult.result,
                    error: attemptResult.error,
                    retryable: false,
                    retriesExhausted: false,
                    hardFailover: false,
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
                    hardFailover: false,
                };
            }

            if (shouldStopRetrying(attemptResult, attempt, maxRetries)) {
                return {
                    status: 'failed',
                    result: '',
                    error: lastError,
                    retryable: attemptResult.shouldRetry,
                    retriesExhausted: attemptResult.shouldRetry && attempt >= maxRetries,
                    hardFailover: attemptResult.hardFailover,
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
            hardFailover: false,
        };
    }

    /**
     * Run a single summarizer attempt and classify the outcome.
     * @param {object} p
     * @param {ExtensionSettings} p.settings - Settings
     * @param {string} p.systemPrompt - System prompt sent to the summarizer
     * @param {string} p.prompt - The fully substituted prompt
     * @param {AbortSignal} p.signal
     * @param {number} p.attempt - Zero-based attempt index
     * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
     * @param {string} p.routeLabel - Human-readable route label for trace logs
     * @param {number} p.maxRetries - Maximum retry count for this route
     * @param {number} p.timeoutMs - Timeout in milliseconds for this attempt
     * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean }>}
     */
    async executeAttempt({
        settings,
        systemPrompt,
        prompt,
        signal,
        attempt,
        metadata,
        routeLabel,
        maxRetries,
        timeoutMs,
    }) {
        trace(`  ${routeLabel} attempt ${attempt} starting...`);
        const startedAt = Date.now();
        let rawResult = '';
        let cleanedResult = '';
        let attemptError = null;
        let status = 'failed';

        try {
            if (attempt > 0) {
                debug(`${routeLabel} retry attempt ${attempt}/${maxRetries}`);
            }

            await traceSummarizerRequest({ settings, systemPrompt, prompt, metadata });

            const abortContext = createAttemptAbortContext(signal, timeoutMs);

            try {
                rawResult = await Promise.race([
                    sendSummarizerRequest(
                        settings,
                        systemPrompt,
                        prompt,
                        abortContext.signal,
                        metadata,
                    ),
                    abortContext.promise,
                ]);
            } finally {
                abortContext.cleanup();
            }

            trace('  sendSummarizerRequest returned:', rawResult?.substring?.(0, 50));

            const processed = processSummarizerResponse(rawResult, settings, metadata);
            cleanedResult = processed.text;
            if (processed.status !== 'success') {
                attemptError = processed.error;
                status = processed.status;
                if (processed.status === 'empty') {
                    debug('Empty response from LLM, treating as retryable');
                }
                return buildAttemptFailure(attemptError, true);
            }

            await recordSuccessfulSummarizerUsage({
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
                hardFailover: false,
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
                error: attemptError,
            });
        }
    }
}

/**
 * Compute timeout for a specific attempt based on call type and attempt index.
 * L0 (user-facing) gets more patience; L1+ (background promotion) gets less.
 * @param {object} metadata - Call metadata
 * @param {number} attempt - Zero-based attempt index
 * @returns {number} Timeout in milliseconds
 */
function computeAttemptTimeoutMs(metadata = {}, attempt) {
    const isPromotion = metadata.kind === 'promotion';
    if (!isPromotion) {
        return attempt === 0 ? 120000 : 90000;
    }
    return attempt === 0 ? 90000 : 60000;
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
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean }}
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
        return {
            success: false,
            result: '',
            error,
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
        };
    }

    const isHardNetworkFailure = isHardNetworkError(error);
    if (isHardNetworkFailure) {
        info('Hard network failure detected; skipping retries for this route.', error.message);
        return {
            success: false,
            result: '',
            error,
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
        };
    }

    const shouldRetry = isRetryableError(error);
    if (!shouldRetry) {
        logError('Non-retryable error:', error);
    }

    return buildAttemptFailure(error, shouldRetry);
}

/**
 * Detect definitive, non-recoverable connection-level failures that will not
 * succeed on retry and should trigger immediate failover instead.
 * @param {Error & { message?: string, name?: string }} error
 * @returns {boolean}
 */
function isHardNetworkError(error) {
    const msg = (error?.message || '').toLowerCase();
    if (!msg) {
        return false;
    }
    return (
        msg.includes('failed to fetch') ||
        msg.includes('econnrefused') ||
        msg.includes('err_connection_refused') ||
        msg.includes('err_name_not_resolved') ||
        msg.includes('err_internet_disconnected')
    );
}

/**
 * Build a failed attempt result.
 * @param {Error} error - Attempt error
 * @param {boolean} shouldRetry - Whether retry should continue
 * @returns {{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean, hardFailover: boolean }}
 */
function buildAttemptFailure(error, shouldRetry) {
    return {
        success: false,
        result: '',
        error,
        aborted: false,
        shouldRetry,
        hardFailover: false,
    };
}

/**
 * Decide whether retry processing should stop.
 * @param {{ shouldRetry: boolean, hardFailover?: boolean }} attemptResult - Attempt result
 * @param {number} attempt - Zero-based attempt index
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {boolean}
 */
function shouldStopRetrying(attemptResult, attempt, maxRetries) {
    if (attemptResult.hardFailover) {
        trace('  HARD NETWORK FAILURE, SKIPPING RETRIES FOR THIS ROUTE');
        return true;
    }

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
 * Notify the user that both routes failed, then wait before restarting from primary.
 * @param {object} p
 * @param {string} p.healthBucket
 * @param {AbortSignal} p.signal
 * @returns {Promise<void>}
 */
async function notifyRouteCycleFailedAndWait({ healthBucket, signal }) {
    const delay = computeRetryDelay(new Error('Both routes failed'), ROUTE_CYCLE_RETRY_ATTEMPT);
    const delaySec = (delay / 1000).toFixed(1);
    info(
        `Both primary and fallback exhausted for ${healthBucket}; ` +
            `resetting health state and retrying primary in ${delaySec}s.`,
    );
    toastr.warning(
        `Both summarizer routes failed. Retrying primary in ${delaySec}s...`,
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
 * @param {{ retriesExhausted?: boolean }} [options]
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
 * Describe a summarizer request for prompt logs.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function describePromptLogCall(metadata = {}) {
    if (metadata.kind === 'layer0') {
        return `L0 turns ${formatPromptLogRange(metadata.sourceRange)}`;
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
function logLlmAttemptTransaction({
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
