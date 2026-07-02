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
