import { ConnectionError } from './connection-error.js';
import {
    fetchWithProxyFallback,
    isLocalUrl,
    normalizeOpenAIEndpoint,
    readErrorText,
} from './connection-transport.js';

/**
 * OpenAI-compatible streaming chat adapter.
 * @type {ConnectionProvider}
 */
export const OpenAIProvider = {
    async generate({ settings, systemPrompt, userPrompt }) {
        return await sendViaOpenAI({
            url: settings.openaiUrl,
            apiKey: settings.openaiKey,
            model: settings.openaiModel,
            systemPrompt,
            userPrompt,
            maxTokens: settings.openaiMaxTokens,
        });
    },
    async testConnection(settings) {
        return await testOpenAIConnection(
            settings.openaiUrl,
            settings.openaiKey,
            settings.openaiModel,
        );
    },
    displayName(settings) {
        return `OpenAI: ${settings.openaiModel || '(no model)'}`;
    },
};

/**
 * @typedef {object} OpenAIRequestParams
 * @property {string} url - The endpoint base URL
 * @property {string} apiKey - The API key
 * @property {string} model - The model name
 * @property {string} systemPrompt - The system prompt
 * @property {string} userPrompt - The user prompt
 * @property {number} [maxTokens] - Max tokens for the response
 */

/**
 * @typedef {object} OpenAIFetchOptions
 * @property {string} endpoint - The normalized endpoint URL
 * @property {boolean} useProxy - Whether to route through ST's CORS proxy
 * @property {Record<string, string>} headers - Request headers
 * @property {string} body - JSON request body
 * @property {string} baseUrl - The original base URL
 */

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * @param {OpenAIRequestParams} params
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

    /** @type {Record<string, string>} */
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
 * @param {{ model: string, systemPrompt: string, userPrompt: string, tokenLimit?: number }} params
 * @returns {string} JSON-encoded request body
 */
function buildOpenAIRequestBody({ model, systemPrompt, userPrompt, tokenLimit }) {
    /** @type {{ model: string, messages: Array<{ role: string, content: string }>, temperature: number, stream: boolean, max_tokens?: number }} */
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
 * @param {OpenAIFetchOptions} opts
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

/**
 * Read an SSE stream and assemble the full content.
 * @param {Response} response
 * @returns {Promise<string>} The assembled content
 * @throws {ConnectionError} retryable when the stream ends before `[DONE]`
 * @throws {DOMException} AbortError when the underlying reader is aborted
 */
async function readSSEStream(response) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await readSSEChunk(reader);
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const event = parseSSELine(line);
                if (event.done) {
                    return fullContent;
                }
                fullContent += event.content;
            }
        }
    } finally {
        reader.releaseLock();
    }

    buffer += decoder.decode();
    const finalEvent = parseSSELine(buffer);
    if (finalEvent.done) {
        return fullContent;
    }

    throw new ConnectionError('OpenAI Compatible stream ended before the [DONE] marker.', {
        retryable: true,
    });
}

/**
 * Read one SSE chunk, preserving AbortError semantics and making disconnects retryable.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 * @throws {ConnectionError} retryable when the stream read fails
 * @throws {DOMException} AbortError when the underlying reader is aborted
 */
async function readSSEChunk(reader) {
    try {
        return await reader.read();
    } catch (err) {
        if (/** @type {{ name?: string }} */ (err)?.name === 'AbortError') {
            throw err;
        }
        throw new ConnectionError(
            `OpenAI Compatible stream disconnected before completion: ${
                /** @type {{ message?: string }} */ (err)?.message ?? 'unknown error'
            }`,
            { retryable: true },
        );
    }
}

/**
 * Parse a single SSE data line and extract delta content.
 * @param {string} line - Raw SSE line
 * @returns {{ content: string, done: boolean }} Parsed content and completion state
 */
function parseSSELine(line) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) {
        return { content: '', done: false };
    }

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
        return { content: '', done: true };
    }

    try {
        const parsed = /** @type {OpenAIChatCompletionChunk} */ (JSON.parse(data));
        return { content: extractDeltaContent(parsed.choices?.[0]), done: false };
    } catch (_e) {
        return { content: '', done: false };
    }
}

/**
 * Extract string content from an OpenAI-compatible stream choice.
 * @param {OpenAIChatCompletionChoice | undefined} choice
 * @returns {string}
 */
function extractDeltaContent(choice) {
    const delta = /** @type {OpenAIChatCompletionDelta | undefined} */ (choice?.delta);
    return typeof delta?.content === 'string' ? delta.content : '';
}
