import { CONNECTION_MODULE_NAME } from './connection-error.js';
import { getRequestHeaders } from '../foundation/context.js';

const LOCAL_URL_RE =
    /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i;

/**
 * Check whether a URL points to a local/private network address.
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalUrl(url) {
    return LOCAL_URL_RE.test(url);
}

/**
 * Normalize an OpenAI-compatible base URL into a /chat/completions endpoint.
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeOpenAIEndpoint(baseUrl) {
    let endpoint = baseUrl.replace(/\/+$/, '');
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) {
            endpoint += '/chat/completions';
        } else if (!endpoint.includes('/chat/completions')) {
            endpoint += '/v1/chat/completions';
        }
    }
    return endpoint;
}

/**
 * Read response error text with a safe fallback.
 * @param {Response} response
 * @returns {Promise<string>}
 */
export async function readErrorText(response) {
    return await response.text().catch(() => 'Unknown error');
}

/**
 * Attempt a fetch through ST's CORS proxy, falling back to a direct request.
 * Throws an Error with .proxyError and .directError properties if both fail.
 * @param {string} targetUrl - The direct URL to fetch
 * @param {object} opts - Fetch options (method, headers, body)
 * @returns {Promise<Response>}
 */
export async function fetchWithProxyFallback(
    targetUrl,
    { method = 'GET', headers = {}, body } = {},
) {
    const requestHeaders = { 'Content-Type': 'application/json', ...headers };
    try {
        return await fetch(proxiedUrl(targetUrl), {
            method,
            headers: { ...getProxyHeaders(), ...requestHeaders },
            body,
        });
    } catch (proxyError) {
        console.warn(
            `${CONNECTION_MODULE_NAME} CORS proxy failed, trying direct:`,
            proxyError.message,
        );
        try {
            return await fetch(targetUrl, {
                method,
                headers: requestHeaders,
                body,
            });
        } catch (directError) {
            const combined = /** @type {Error & { proxyError: unknown, directError: unknown }} */ (
                new Error('Both proxy and direct fetch failed')
            );
            combined.proxyError = proxyError;
            combined.directError = directError;
            throw combined;
        }
    }
}

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} The possibly proxied URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) {
        return url;
    }
    return `/proxy/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * @returns {object}
 */
function getProxyHeaders() {
    return getRequestHeaders();
}
