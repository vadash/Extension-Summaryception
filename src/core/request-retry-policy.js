import {
    RETRY_CONFIG,
    isRetryableError,
    parseRetryAfter,
    sleepOrAbort,
} from '../foundation/retry.js';
import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';

export const ROUTE_CYCLE_RETRY_ATTEMPT = RETRY_CONFIG.maxRetries;

/**
 * Compute the retry delay for a given attempt, honoring Retry-After headers.
 * @param {Error|object} err - The error from the failed attempt
 * @param {number} attempt - Zero-based attempt index
 * @returns {number} Delay in milliseconds
 */
export function computeRetryDelay(err, attempt) {
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
 * Announce a retry wait and sleep it out. The delay policy and the wait stay
 * together here; the abort signal cuts the wait short.
 * @param {object} p
 * @param {Error & { status?: number, response?: { status?: number } }} p.lastError - The error that triggered the retry.
 * @param {number} p.attempt - Zero-based attempt index.
 * @param {AbortSignal} p.signal - Signal that cuts the wait short.
 * @param {number} p.maxRetries - Maximum retry count for this route.
 * @param {import('./notify.js').NotifyAdapter} p.notify - Notify adapter for the retry notice.
 * @returns {Promise<void>}
 */
export async function notifyRetryAndWait({ lastError, attempt, signal, maxRetries, notify }) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';
    warn(
        `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        lastError.message || lastError,
    );
    notify.transient({
        kind: NOTIFY_EVENTS.RETRY_WAIT,
        attempt,
        delayMs: delay,
        maxRetries,
    });
    await sleepOrAbort(delay, signal);
}

/**
 * @param {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} error
 * @param {boolean} signalAborted
 * @returns {{ aborted: boolean, shouldRetry: boolean, hardFailover: boolean }}
 */
export function classifyAttemptRetryStatus(error, signalAborted) {
    if (signalAborted || error.message === 'Aborted by user') {
        return {
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
        };
    }

    if (isHardNetworkError(error)) {
        return {
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
        };
    }

    return {
        aborted: false,
        shouldRetry: isRetryableError(error),
        hardFailover: false,
    };
}

/**
 * Detect connection-level failures that a retry cannot fix. The route skips
 * its remaining retries and starts fallback.
 * @param {Error & { message?: string, name?: string }} error
 * @returns {boolean}
 */
export function isHardNetworkError(error) {
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
 * @param {object} p
 * @param {{ status: string }} p.attemptResult - Attempt result; `rejected` marks an Output Hygiene validation failure
 * @param {number} p.attempt - Zero-based attempt index
 * @param {number} p.maxRetries - Maximum retry count for this route
 * @param {string} p.repairPrompt - Fully substituted repair prompt
 * @returns {boolean}
 */
export function shouldSwitchToRepairPrompt({ attemptResult, attempt, maxRetries, repairPrompt }) {
    return Boolean(repairPrompt) && attempt < maxRetries && attemptResult.status === 'rejected';
}

/**
 * @param {{ status: 'hard-failover' | 'guard-stopped' | 'failed' | 'rejected', retryable?: boolean }} attemptResult - Attempt result
 * @param {number} attempt - Zero-based attempt index
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {'' | 'hard-failover' | 'non-retryable' | 'primary-probe-failed' | 'retries-exhausted'}
 */
export function getRetryStopReason(attemptResult, attempt, maxRetries) {
    if (attemptResult.status === 'hard-failover') {
        return 'hard-failover';
    }
    if (attemptResult.status === 'guard-stopped') {
        return 'non-retryable';
    }
    if (attemptResult.status === 'failed' && !attemptResult.retryable) {
        return 'non-retryable';
    }
    if (attempt >= maxRetries) {
        return maxRetries === 0 ? 'primary-probe-failed' : 'retries-exhausted';
    }
    return '';
}
