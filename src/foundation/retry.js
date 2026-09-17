import { RETRY_CONFIG, ROUTE_CYCLE_FAILURE_BUDGET } from './constants.js';

export { RETRY_CONFIG, ROUTE_CYCLE_FAILURE_BUDGET };

/**
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Resolves after the delay
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} ms - Milliseconds to sleep
 * @param {AbortSignal} signal - Signal whose abort cuts the wait short
 * @returns {Promise<void>} Resolves after the delay or on abort
 */
export function sleepOrAbort(ms, signal) {
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const onTimeout = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const timer = setTimeout(onTimeout, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * @param {object} error - The error to inspect
 * @returns {number|null} Milliseconds to wait, or null if not found
 */
export function parseRetryAfter(error) {
    try {
        const retryAfter =
            error?.response?.headers?.['retry-after'] ||
            error?.retryAfter ||
            error?.data?.retry_after;
        if (!retryAfter) {
            return null;
        }
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) {
            return seconds * 1000;
        }
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (_e) {
        /* ignore */
    }
    return null;
}

const RETRYABLE_MESSAGE_PATTERNS = [
    'rate limit',
    'too many requests',
    'server error',
    'timeout',
    'timed out',
    'econnreset',
    'network',
    'overloaded',
    'capacity',
];

/**
 * @param {string} msg - The error message string
 * @returns {boolean} True if a retryable pattern is found
 */
function msgHasRetryablePattern(msg) {
    for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
        if (msg.includes(pattern)) {
            return true;
        }
    }
    return false;
}

/**
 * @param {object} error - The error to check
 * @returns {boolean} True if the status code is retryable
 */
function statusCodeIsRetryable(error) {
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) {
        return true;
    }
    return false;
}

/**
 * @param {object} error
 * @returns {boolean}
 */
function isRetryableTypeError(error) {
    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) {
        return true;
    }
    return statusCodeIsRetryable(error);
}

/**
 * @param {object} error - The error to evaluate
 * @returns {boolean} True if the error is retryable
 */
export function isRetryableError(error) {
    if (error?.name === 'AbortError') {
        return false;
    }
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }
    if (isRetryableTypeError(error)) {
        return true;
    }
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    return msgHasRetryablePattern(msg);
}
