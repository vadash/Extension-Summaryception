import { CONNECTION_MODULE_NAME, ConnectionError } from './connection-error.js';
import {
    fetchWithProxyFallback,
    isLocalUrl,
    normalizeOpenAIEndpoint,
    readErrorText,
} from './connection-transport.js';

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * @param {object} params
 * @param {string} params.url - The endpoint base URL
 * @param {string} params.apiKey - The API key
 * @param {string} params.model - The model name
 * @param {string} params.systemPrompt - The system prompt
 * @param {string} params.userPrompt - The user prompt
 * @param {number} [params.maxTokens] - Max tokens for the response
 * @returns {Promise<string>} The generated response content
 */
export async function sendViaOpenAI({ url, apiKey, model, systemPrompt, userPrompt, maxTokens }) {
    if (!url) {
        throw new ConnectionError(
            'OpenAI Compatible URL is not configured. Please set it in Summaryception settings.',
            { retryable: false },
        );
    }
    if (!model) {
        throw new ConnectionError(
            'OpenAI Compatible model name is not set. Please enter one in Summaryception settings.',
            { retryable: false },
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const endpoint = normalizeOpenAIEndpoint(baseUrl);
    const useProxy = isLocalUrl(endpoint);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const tokenLimit = maxTokens && maxTokens > 0 ? maxTokens : undefined;
    const body = buildOpenAIRequestBody({ model, systemPrompt, userPrompt, tokenLimit });

    const response = await executeOpenAIFetch({ endpoint, useProxy, headers, body, baseUrl });

    if (!response.ok) {
        await handleOpenAIErrorResponse(response);
    }

    const fullContent = await readSSEStream(response);

    if (!fullContent.trim()) {
        throw new ConnectionError(
            'OpenAI Compatible endpoint returned an empty response (streaming).',
            { retryable: true },
        );
    }

    return fullContent;
}

/**
 * Test the connection to an OpenAI-compatible endpoint.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendViaOpenAI({
            url,
            apiKey,
            model: model || 'test',
            systemPrompt: 'You are a test assistant.',
            userPrompt: 'Respond with exactly: CONNECTION_OK',
            maxTokens: 100,
        });
        return {
            success: true,
            message: `Connection successful! Response: "${result.substring(0, 100)}"`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Connection failed: ${error.message}`,
        };
    }
}

/**
 * Build the request body for an OpenAI-compatible streaming call.
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {number|undefined} params.tokenLimit
 * @returns {string} JSON-encoded request body
 */
function buildOpenAIRequestBody({ model, systemPrompt, userPrompt, tokenLimit }) {
    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        stream: true,
    };
    if (tokenLimit) {
        requestBody.max_tokens = tokenLimit;
    }
    return JSON.stringify(requestBody);
}

/**
 * Execute the fetch for an OpenAI-compatible endpoint, using proxy for local URLs.
 * @param {object} opts
 * @param {string} opts.endpoint - The normalized endpoint URL
 * @param {boolean} opts.useProxy - Whether to route through ST's CORS proxy
 * @param {object} opts.headers - Request headers
 * @param {string} opts.body - JSON request body
 * @param {string} opts.baseUrl - The original base URL
 * @returns {Promise<Response>}
 * @throws {ConnectionError}
 */
async function executeOpenAIFetch({ endpoint, useProxy, headers, body, baseUrl }) {
    try {
        if (useProxy) {
            return await fetchWithProxyFallback(endpoint, { method: 'POST', headers, body });
        }
        return await fetch(endpoint, { method: 'POST', headers, body });
    } catch (e) {
        const err =
            /** @type {{ proxyError?: { message: string }, directError?: { message: string }, message: string }} */ (
                e
            );
        if (err.proxyError) {
            throw new ConnectionError(
                `Failed to connect to ${baseUrl}. ` +
                    'Enable the CORS proxy in config.yaml (enableCorsProxy: true). ' +
                    `Proxy error: ${err.proxyError.message}. Direct error: ${err.directError?.message ?? 'unknown'}`,
                { retryable: true },
            );
        }
        throw new ConnectionError(`Failed to connect to ${baseUrl}: ${err.message}`, {
            retryable: true,
        });
    }
}

/**
 * Handle a non-OK response from an OpenAI-compatible endpoint.
 * @param {Response} response
 * @returns {Promise<never>}
 * @throws {ConnectionError}
 */
async function handleOpenAIErrorResponse(response) {
    const errorText = await readErrorText(response);
    if (response.status === 401) {
        throw new ConnectionError(
            'OpenAI Compatible endpoint returned 401 Unauthorized. Check your API key.',
            { retryable: false, status: 401 },
        );
    }
    if (response.status === 403) {
        throw new ConnectionError(
            `OpenAI Compatible endpoint returned 403 Forbidden: ${errorText}`,
            { retryable: false, status: 403 },
        );
    }
    throw new ConnectionError(
        `OpenAI Compatible request failed (${response.status}): ${errorText}`,
        {
            retryable: response.status >= 500 || response.status === 429,
            status: response.status,
        },
    );
}

// Minimum assembled content length (chars) to accept a truncated stream as a
// partial summary instead of rejecting it for retry. Roughly one short
// sentence; well below typical 200-800 char summaries, above noise.
const PARTIAL_MIN_CHARS = 64;

/**
 * Read an SSE stream and assemble the full content.
 *
 * Resilient to mid-stream disconnects and malformed trailing chunks:
 * - Aborts propagate unchanged so the caller can classify them as user aborts.
 * - Other read errors flush the residual buffer; if the assembled content meets
 *   {@link PARTIAL_MIN_CHARS}, it is returned with a warning, otherwise a
 *   retryable ConnectionError is thrown.
 * - On normal completion, any buffered line lacking a trailing newline is
 *   flushed so the final SSE event is not silently dropped.
 *
 * @param {Response} response
 * @returns {Promise<string>} The assembled content (possibly partial)
 * @throws {ConnectionError} retryable when a disconnect yields too little content
 * @throws {DOMException} AbortError when the underlying reader is aborted
 */
async function readSSEStream(response) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
        while (true) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    fullContent += parseSSELine(line);
                }
            } catch (err) {
                return handleStreamReadError(err, fullContent, buffer);
            }
        }
    } finally {
        reader.releaseLock();
    }

    fullContent += parseSSELine(buffer);
    return fullContent;
}

/**
 * Classify a read-loop error: rethrow aborts, accept partial content above the
 * threshold with a warning, otherwise throw a retryable ConnectionError.
 *
 * @param {unknown} err - The rejected error from `reader.read()`
 * @param {string} fullContent - Assembled content so far
 * @param {string} buffer - Unparsed residual buffer to flush before deciding
 * @returns {string} The accepted partial content (only on the accept path)
 * @throws {DOMException} rethrows when `err` is an AbortError
 * @throws {ConnectionError} retryable when partial content is below threshold
 */
function handleStreamReadError(err, fullContent, buffer) {
    if (/** @type {{ name?: string }} */ (err)?.name === 'AbortError') {
        throw err;
    }

    const flushed = fullContent + parseSSELine(buffer);
    const trimmed = flushed.trim();

    if (trimmed.length >= PARTIAL_MIN_CHARS) {
        console.warn(
            CONNECTION_MODULE_NAME,
            `Stream disconnected after ${trimmed.length} chars; returning partial summary.`,
        );
        return flushed;
    }

    throw new ConnectionError(
        `Stream disconnected after ${trimmed.length} chars (below ${PARTIAL_MIN_CHARS} char minimum): ${
            /** @type {{ message?: string }} */ (err)?.message ?? 'unknown error'
        }`,
        { retryable: true },
    );
}

/**
 * Parse a single SSE data line and extract delta content.
 * @param {string} line - Raw SSE line
 * @returns {string} The delta content, or '' if unparseable/irrelevant
 */
function parseSSELine(line) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) {
        return '';
    }

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
        return '';
    }

    try {
        const parsed = JSON.parse(data);
        return parsed.choices?.[0]?.delta?.content || '';
    } catch (_e) {
        return '';
    }
}
