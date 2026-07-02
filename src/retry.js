import { RETRY_CONFIG } from './constants.js';

export { RETRY_CONFIG };

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export function isRetryableError(error) {
    if (error?.name === 'AbortError') {
        return false;
    }

    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) {
        return true;
    }
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) {
        return true;
    }
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) {
        return true;
    }
    if (msg.includes('too many requests')) {
        return true;
    }
    if (msg.includes('server error')) {
        return true;
    }
    if (msg.includes('timeout')) {
        return true;
    }
    if (msg.includes('econnreset')) {
        return true;
    }
    if (msg.includes('econnrefused')) {
        return true;
    }
    if (msg.includes('network')) {
        return true;
    }
    if (msg.includes('overloaded')) {
        return true;
    }
    if (msg.includes('capacity')) {
        return true;
    }
    return false;
}
