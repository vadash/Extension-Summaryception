import { RETRY_CONFIG, isRetryableError, parseRetryAfter } from '../foundation/retry.js';

const PRIMARY_HEALTH_BUCKETS = Object.freeze({
    layer0: 'layer0',
    l1plus: 'l1plus',
});

export const ROUTE_CYCLE_RETRY_ATTEMPT = RETRY_CONFIG.maxRetries;

/**
 * Compute timeout for a specific attempt based on call type and attempt index.
 * L0 (user-facing) gets more patience; L1+ (background promotion) gets less.
 * @param {object} metadata - Call metadata
 * @param {number} attempt - Zero-based attempt index
 * @returns {number} Timeout in milliseconds
 */
export function computeAttemptTimeoutMs(metadata = {}, attempt) {
    const isPromotion = metadata.kind === 'promotion';
    if (!isPromotion) {
        return attempt === 0 ? 120000 : 90000;
    }
    return attempt === 0 ? 90000 : 60000;
}

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
 * Classify an attempt exception for retry/failover control flow.
 * @param {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} error
 * @param {boolean} signalAborted
 * @returns {{ aborted: boolean, shouldRetry: boolean, hardFailover: boolean, failureStatus: string }}
 */
export function classifyAttemptRetryStatus(error, signalAborted) {
    if (signalAborted || error.message === 'Aborted by user') {
        return {
            aborted: true,
            shouldRetry: false,
            hardFailover: false,
            failureStatus: 'aborted',
        };
    }

    if (isHardNetworkError(error)) {
        return {
            aborted: false,
            shouldRetry: false,
            hardFailover: true,
            failureStatus: 'hard-failover',
        };
    }

    return {
        aborted: false,
        shouldRetry: isRetryableError(error),
        hardFailover: false,
        failureStatus: 'failed',
    };
}

/**
 * Detect definitive, non-recoverable connection-level failures that will not
 * succeed on retry and should trigger immediate failover instead.
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

function isValidationFailureStatus(status) {
    return (
        status === 'empty' ||
        status === 'cn-rejected' ||
        status === 'integrity-rejected' ||
        status === 'size-rejected'
    );
}

/**
 * Decide whether the next retry should use the repair prompt.
 * @param {object} p
 * @param {{ shouldRetry: boolean, failureStatus?: string }} p.attemptResult - Attempt result
 * @param {number} p.attempt - Zero-based attempt index
 * @param {number} p.maxRetries - Maximum retry count for this route
 * @param {string} p.repairPrompt - Fully substituted repair prompt
 * @returns {boolean}
 */
export function shouldSwitchToRepairPrompt({ attemptResult, attempt, maxRetries, repairPrompt }) {
    return (
        Boolean(repairPrompt) &&
        attempt < maxRetries &&
        attemptResult.shouldRetry &&
        isValidationFailureStatus(attemptResult.failureStatus)
    );
}

/**
 * Decide why retry processing should stop.
 * @param {{ shouldRetry: boolean, hardFailover?: boolean }} attemptResult - Attempt result
 * @param {number} attempt - Zero-based attempt index
 * @param {number} maxRetries - Maximum retry count for this route
 * @returns {'' | 'hard-failover' | 'non-retryable' | 'primary-probe-failed' | 'retries-exhausted'}
 */
export function getRetryStopReason(attemptResult, attempt, maxRetries) {
    if (attemptResult.hardFailover) {
        return 'hard-failover';
    }
    if (!attemptResult.shouldRetry) {
        return 'non-retryable';
    }
    if (attempt >= maxRetries) {
        return maxRetries === 0 ? 'primary-probe-failed' : 'retries-exhausted';
    }
    return '';
}

/**
 * Split primary health tracking by prompt family so Layer 0 and L1+ failures
 * do not influence each other.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
export function getPrimaryHealthBucket(metadata = {}) {
    return metadata.kind === 'promotion'
        ? PRIMARY_HEALTH_BUCKETS.l1plus
        : PRIMARY_HEALTH_BUCKETS.layer0;
}
