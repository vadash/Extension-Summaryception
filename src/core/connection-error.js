import { serializeError } from '../foundation/logger.js';
import { isHardNetworkError } from './request-retry-policy.js';

export const CONNECTION_MODULE_NAME = '[Summaryception][Connection]';

/**
 * Error class for connection errors with explicit retryable flag.
 * The retry logic checks this to avoid burning through retries on errors that
 * will never succeed, such as missing config, auth failures, or deleted profiles.
 */
export class ConnectionError extends Error {
    /**
     * @param {string} message
     * @param {{ retryable?: boolean, status?: number | null }} [options]
     */
    constructor(message, { retryable = false, status = null } = {}) {
        super(message);
        this.name = 'ConnectionError';
        this.retryable = retryable;
        this.status = status;
    }
}

/**
 * Detect an authentication failure (401 status or auth-related message text).
 * Procedure: Compare the error status and message against the known auth
 * failure patterns (401 status, "401" text, "unauthorized" text).
 * @param {string} msg - The error message
 * @param {number | null} status - The extracted HTTP status, or null
 * @returns {boolean}
 */
function isAuthFailure(msg, status) {
    return status === 401 || msg.includes('401') || msg.toLowerCase().includes('unauthorized');
}

/**
 * Wrap a raw error into a ConnectionError with normalized fields.
 * Procedure: Extract status and retryable from the raw error, apply the
 * caller override, then shape the message per the failure kind. An explicit
 * message bypasses classification and is used verbatim.
 * @param {unknown} error - The raw error to wrap
 * @param {{ profileId?: string, retryable?: boolean | null, message?: string | null }} [options]
 * @param {string} [fallbackLabel] - Prefix for the classified message
 * @returns {ConnectionError}
 */
export function wrapConnectionError(
    error,
    { profileId, retryable = null, message = null } = {},
    fallbackLabel,
) {
    const { message: msg, status, retryable: rawRetryable } = serializeError(error);
    const retryableFlag =
        typeof retryable === 'boolean'
            ? retryable
            : typeof rawRetryable === 'boolean'
              ? rawRetryable
              : !isHardNetworkError(/** @type {Error} */ (error));

    if (message !== null) {
        return new ConnectionError(message, { retryable: retryableFlag, status });
    }

    if (isAuthFailure(msg, status)) {
        return new ConnectionError(
            `${fallbackLabel || 'Connection'} auth failed (401). This is likely the API key ` +
                'switching bug (ST Issue #5348). Update SillyTavern to staging (March 30, 2026+) ' +
                `to fix this. Original error: ${msg}`,
            { retryable: false, status: 401 },
        );
    }

    if (msg.includes('not found') || msg.includes('profile')) {
        return new ConnectionError(
            `${fallbackLabel || 'Connection'} "${profileId}" not found. It may have been deleted. ` +
                'Please re-select a profile in Summaryception settings.',
            { retryable: false, status: 404 },
        );
    }

    return new ConnectionError(`${fallbackLabel || 'Connection'} request failed: ${msg}`, {
        retryable: retryableFlag,
        status,
    });
}
