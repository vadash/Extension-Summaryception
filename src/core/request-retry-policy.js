import { RETRY_CONFIG, isRetryableError, parseRetryAfter } from '../foundation/retry.js';

const PRIMARY_HEALTH_BUCKETS = Object.freeze({
    layer0: 'layer0',
    l1plus: 'l1plus',
});

// Hardcoded fallbacks (ms) used when no per-route timeout setting is supplied.
const FALLBACK_TIMEOUT_MS = Object.freeze({
    layer0: 120000,
    promotion: 90000,
});

export const ROUTE_CYCLE_RETRY_ATTEMPT = RETRY_CONFIG.maxRetries;

/**
 * Compute the timeout for one attempt from the configured per-route timeout
 * (seconds, read from the base settings). Every attempt of a route series uses
 * the full configured timeout. A backend that needs the whole window fails a
 * shortened retry, so retries never run shorter. L0 (user-facing) defaults
 * higher than L1+ (background promotion) when the route setting is unset.
 * @param {object} [metadata] - Call metadata (kind / useFallback pick the route)
 * @param {number} [_attempt] - Zero-based attempt index (unused; kept for signature stability)
 * @param {object} [settings] - Base extension settings carrying the prefixed timeout fields
 * @returns {number} Timeout in milliseconds
 */
export function computeAttemptTimeoutMs(metadata = {}, _attempt = 0, settings = {}) {
    const configuredSeconds = resolveTimeoutSeconds(metadata, settings);
    if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
        return fallbackTimeoutMs(metadata);
    }
    return configuredSeconds * 1000;
}

/**
 * The metadata.kind (promotion vs layer0/regenerate) and metadata.useFallback flag
 * select which route's timeout field applies:
 *   - fallback route        → fallbackRequestTimeoutSeconds
 *   - L1+ promotion route   → mergeRequestTimeoutSeconds
 *   - Layer 0 / regenerate   → requestTimeoutSeconds
 * @param {object} metadata - Call metadata
 * @param {object} settings - Base extension settings
 * @returns {number} Configured timeout in seconds, or NaN if unset
 */
function resolveTimeoutSeconds(metadata, settings) {
    if (metadata.useFallback) {
        return Number(settings?.fallbackRequestTimeoutSeconds);
    }
    if (metadata.kind === 'promotion') {
        return Number(settings?.mergeRequestTimeoutSeconds);
    }
    return Number(settings?.requestTimeoutSeconds);
}

function fallbackTimeoutMs(metadata) {
    return metadata.kind === 'promotion'
        ? FALLBACK_TIMEOUT_MS.promotion
        : FALLBACK_TIMEOUT_MS.layer0;
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

function isValidationFailureStatus(status) {
    return (
        status === 'empty' ||
        status === 'cn-rejected' ||
        status === 'integrity-rejected' ||
        status === 'size-rejected'
    );
}

/**
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
