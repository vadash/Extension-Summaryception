/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default:  SillyTavern's generateRaw() (active connection)
 *   - profile:  ST Connection Profile via ConnectionManagerRequestService
 *   - ollama:   Ollama instance (via ST CORS proxy to avoid browser CORS issues)
 *   - openai:   OpenAI-compatible endpoint (via ST CORS proxy, streaming supported)
 *
 * CORS Note: Ollama and OpenAI modes route through ST's /cors/ proxy endpoint
 * to avoid browser CORS restrictions. Requires enableCorsProxy: true in config.yaml
 * OR the target server must have permissive CORS headers.
 *
 * AGPL-3.0
 */

const MODULE_NAME = '[Summaryception][Connection]';

// ─── Custom Error Class ──────────────────────────────────────────────

/**
 * Error class for connection errors with explicit retryable flag.
 * The retry logic in callSummarizer checks for this to avoid
 * burning through retries on errors that will never succeed
 * (e.g. missing config, auth failures, deleted profiles).
 */
class ConnectionError extends Error {
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

export { ConnectionError };

// ─── CORS Proxy Helper ───────────────────────────────────────────────

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} - The (possibly proxied) URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) {
        return url;
    }
    return `/proxy/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * Required when routing through ST's /cors/ proxy.
 * @returns {object}
 */
function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (_e) {
        /* fallback */
    }
    return { 'Content-Type': 'application/json' };
}

// ─── Transport Helpers ───────────────────────────────────────────────

const LOCAL_URL_RE =
    /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i;

/**
 * Check whether a URL points to a local/private network address.
 * @param {string} url
 * @returns {boolean}
 */
function isLocalUrl(url) {
    return LOCAL_URL_RE.test(url);
}

/**
 * Normalize an OpenAI-compatible base URL into a /chat/completions endpoint.
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeOpenAIEndpoint(baseUrl) {
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
async function readErrorText(response) {
    return await response.text().catch(() => 'Unknown error');
}

/**
 * Attempt a fetch through ST's CORS proxy, falling back to a direct request.
 * Throws an Error with .proxyError and .directError properties if both fail.
 * @param {string} targetUrl - The direct URL to fetch
 * @param {object} opts - Fetch options (method, headers, body)
 * @returns {Promise<Response>}
 */
async function fetchWithProxyFallback(targetUrl, { method = 'GET', headers = {}, body } = {}) {
    const requestHeaders = { 'Content-Type': 'application/json', ...headers };
    try {
        return await fetch(proxiedUrl(targetUrl), {
            method,
            headers: { ...getProxyHeaders(), ...requestHeaders },
            body,
        });
    } catch (proxyError) {
        console.warn(`${MODULE_NAME} CORS proxy failed, trying direct:`, proxyError.message);
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

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} - The generated response text
 * @throws {ConnectionError|Error} - If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt) {
    const source = settings.connectionSource || 'default';

    switch (source) {
        case 'profile':
            return await sendViaProfile(settings.connectionProfileId, systemPrompt, userPrompt);
        case 'ollama':
            return await sendViaOllama(
                settings.ollamaUrl,
                settings.ollamaModel,
                systemPrompt,
                userPrompt,
            );
        case 'openai':
            return await sendViaOpenAI({
                url: settings.openaiUrl,
                apiKey: settings.openaiKey,
                model: settings.openaiModel,
                systemPrompt,
                userPrompt,
                maxTokens: settings.openaiMaxTokens,
            });
        case 'default':
        default:
            return await sendViaDefault(
                systemPrompt,
                userPrompt,
                settings.summarizerResponseLength,
            );
    }
}

// ─── Mode 1: Default (generateRaw) ──────────────────────────────────

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {number} responseLength - Desired response length
 * @returns {Promise<string>} The generated text
 */
async function sendViaDefault(systemPrompt, userPrompt, responseLength) {
    const { generateRaw } = SillyTavern.getContext();

    if (!generateRaw) {
        throw new ConnectionError(
            'generateRaw is not available in the current SillyTavern context.',
            { retryable: false },
        );
    }

    // ST refactored generateRaw from positional args to an object param
    // in PR #4277 (July 2025). We need to support both signatures.
    //
    // New (July 2025+): generateRaw({ prompt, systemPrompt, responseLength })
    // Old (pre-July 2025): generateRaw(prompt, systemPrompt)
    //
    // Detection: the new signature destructures an object, so if we check
    // the function's length (expected positional params), 0 or 1 means
    // object-style, 2+ means positional-style.

    let result;

    if (generateRaw.length <= 1) {
        // Modern ST: object-based params
        const options = {
            systemPrompt: systemPrompt,
            prompt: userPrompt,
        };

        if (responseLength && responseLength > 0) {
            options.responseLength = responseLength;
        }

        result = await generateRaw(options);
    } else {
        // Legacy ST: positional args — generateRaw(prompt, systemPrompt)
        // Note: legacy signature does not support responseLength override
        console.warn(
            '[Summaryception] Detected legacy generateRaw (positional args). ' +
                'Consider updating SillyTavern to July 2025+ for full feature support.',
        );
        result = await generateRaw(
            /** @type {string[] | Record<string, unknown>} */ (/** @type {unknown} */ (userPrompt)),
            systemPrompt,
        );
    }

    if (!result || typeof result !== 'string') {
        throw new ConnectionError('generateRaw returned an empty or invalid response.', {
            retryable: true,
        });
    }

    return result;
}

// ─── Mode 2: Connection Profile ──────────────────────────────────────

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * Requires SillyTavern with PR #3603 merged (March 2025+).
 * Full API key support requires staging with Issue #5348 fix (March 30, 2026+).
 *
 * IMPORTANT: sendRequest() expects messages as an array of {role, content} objects,
 * NOT as a generateRaw()-style options object. Passing {systemPrompt, prompt} as
 * the second argument causes the entire object to be stuffed into the message
 * content field, resulting in "Invalid input" / validation errors from the API.
 * @param {string} profileId - The connection profile identifier
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} The generated response content
 */
async function sendViaProfile(profileId, systemPrompt, userPrompt) {
    if (!profileId) {
        throw new ConnectionError(
            'No Connection Profile selected. Please select one in Summaryception settings.',
            { retryable: false },
        );
    }

    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service) {
        throw new ConnectionError(
            'ConnectionManagerRequestService is not available. ' +
                'Your SillyTavern version may be too old. Requires ST with PR #3603 (March 2025+).',
            { retryable: false },
        );
    }

    if (typeof service.sendRequest !== 'function') {
        throw new ConnectionError(
            'ConnectionManagerRequestService.sendRequest() is not available. ' +
                'Please update SillyTavern to the latest staging version.',
            { retryable: false },
        );
    }

    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const raw = await service.sendRequest(profileId, messages, {
            ignoreInstruct: true,
        });

        console.log('[Summaryception][Connection] Profile sendRequest returned:', typeof raw, raw);

        const result = parseProfileResponse(raw);

        if (!result || !result.trim()) {
            throw new ConnectionError('Connection Profile returned an empty response.', {
                retryable: true,
            });
        }

        return result;
    } catch (error) {
        handleProfileRequestError({ error, profileId });
    }
}

/**
 * Parse the various possible return types from ConnectionManagerRequestService.sendRequest.
 * @param {unknown} raw - The raw response from sendRequest
 * @returns {string} The extracted content string
 * @throws {ConnectionError} If the response type is unexpected or invalid
 */
function parseProfileResponse(raw) {
    if (typeof raw === 'string') {
        return raw;
    }

    const obj = /** @type {Record<string, unknown>} */ (raw);

    if (typeof obj.content === 'string') {
        return obj.content;
    }

    if (
        obj.message &&
        typeof obj.message === 'object' &&
        typeof (/** @type {Record<string, unknown>} */ (obj.message).content) === 'string'
    ) {
        return /** @type {Record<string, unknown>} */ (obj.message).content;
    }

    if (Array.isArray(obj.choices) && obj.choices[0]) {
        const choice = /** @type {Record<string, unknown>} */ (obj.choices[0]);
        if (choice.message && typeof choice.message === 'object') {
            const msg = /** @type {Record<string, unknown>} */ (choice.message);
            if (typeof msg.content === 'string') {
                return msg.content;
            }
        }
    }

    if (obj.data !== null && obj.data !== undefined) {
        return typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data);
    }

    if (raw !== null && raw !== undefined && typeof raw === 'object') {
        const str = JSON.stringify(raw);
        console.warn(
            '[Summaryception][Connection] Unexpected return type from sendRequest:',
            str.substring(0, 500),
        );
        throw new ConnectionError(
            `Connection Profile returned unexpected type: ${typeof raw}. ` +
                `Preview: ${str.substring(0, 200)}. ` +
                'Please report this on the Summaryception GitHub.',
            { retryable: false },
        );
    }

    throw new ConnectionError('Connection Profile returned an empty or invalid response.', {
        retryable: true,
    });
}

/**
 * Wrap a profile request error into a ConnectionError.
 * @param {object} params - Parameters
 * @param {unknown} params.error - The original error
 * @param {string} params.profileId - The profile ID
 * @returns {never} Always throws
 */
function handleProfileRequestError({ error, profileId }) {
    if (error instanceof ConnectionError) {
        throw error;
    }

    const err =
        /** @type {{ message?: string, status?: number, response?: { status?: number } }} */ (
            error
        );
    const msg = err?.message || String(error);
    const status = err?.status || err?.response?.status;

    if (status === 401 || msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        throw new ConnectionError(
            'Connection Profile auth failed (401). This is likely the API key switching bug ' +
                '(ST Issue #5348). Update SillyTavern to staging (March 30, 2026+) to fix this. ' +
                `Original error: ${msg}`,
            { retryable: false, status: 401 },
        );
    }

    if (msg.includes('not found') || msg.includes('profile')) {
        throw new ConnectionError(
            `Connection Profile "${profileId}" not found. It may have been deleted. ` +
                'Please re-select a profile in Summaryception settings.',
            { retryable: false, status: 404 },
        );
    }

    throw new ConnectionError(`Connection Profile request failed: ${msg}`, {
        retryable: true,
        status: status,
    });
}

// ─── Mode 3: Ollama (Local) ─────────────────────────────────────────

/**
 * Send a request to a local Ollama instance using /api/chat.
 * Routes through ST's CORS proxy to avoid browser CORS restrictions.
 * @param {string} url - The Ollama base URL
 * @param {string} model - The model name
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} The generated response content
 */
async function sendViaOllama(url, model, systemPrompt, userPrompt) {
    if (!url) {
        throw new ConnectionError(
            'Ollama URL is not configured. Please set it in Summaryception settings.',
            { retryable: false },
        );
    }
    if (!model) {
        throw new ConnectionError(
            'Ollama model is not selected. Please select one in Summaryception settings.',
            { retryable: false },
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;
    const body = JSON.stringify({
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: { temperature: 0.3 },
    });

    let response;
    try {
        response = await fetchWithProxyFallback(targetUrl, { method: 'POST', body });
    } catch (e) {
        throw new ConnectionError(
            `Failed to connect to Ollama at ${baseUrl}. ` +
                `CORS proxy error: ${e.proxyError.message}. Direct error: ${e.directError.message}. ` +
                'Make sure enableCorsProxy is set to true in config.yaml, or set OLLAMA_ORIGINS=* on your Ollama instance.',
            { retryable: true },
        );
    }

    if (!response.ok) {
        const errorText = await readErrorText(response);
        throw new ConnectionError(`Ollama request failed (${response.status}): ${errorText}`, {
            retryable: response.status >= 500,
            status: response.status,
        });
    }

    const data = await response.json();

    if (!data?.message?.content) {
        throw new ConnectionError('Ollama returned an empty or invalid response.', {
            retryable: true,
        });
    }

    return data.message.content;
}

/**
 * Fetch available models from an Ollama instance.
 * @param {string} url - The Ollama base URL
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
export async function fetchOllamaModels(url) {
    if (!url) {
        throw new Error('Ollama URL is not configured.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;

    let response;
    try {
        response = await fetchWithProxyFallback(targetUrl, { method: 'GET' });
    } catch (e) {
        throw new Error(
            `Failed to connect to Ollama at ${baseUrl}. ` +
                'Enable the CORS proxy in config.yaml (enableCorsProxy: true) or set OLLAMA_ORIGINS=* on your Ollama instance. ' +
                `Proxy error: ${e.proxyError.message}. Direct error: ${e.directError.message}`,
        );
    }

    if (!response.ok) {
        const errorText = await readErrorText(response);
        throw new Error(`Failed to fetch Ollama models (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.models || !Array.isArray(data.models)) {
        throw new Error('Unexpected response format from Ollama /api/tags.');
    }

    return data.models;
}

// ─── Mode 4: OpenAI Compatible (Streaming) ──────────────────────────

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
 * @param {string} endpoint - The normalized endpoint URL
 * @param {boolean} useProxy - Whether to route through ST's CORS proxy
 * @param {object} headers - Request headers
 * @param {string} body - JSON request body
 * @param {string} baseUrl - The original base URL (for error messages)
 * @returns {Promise<Response>}
 */
async function executeOpenAIFetch(endpoint, useProxy, headers, body, baseUrl) {
    try {
        if (useProxy) {
            return await fetchWithProxyFallback(endpoint, { method: 'POST', headers, body });
        }
        return await fetch(endpoint, { method: 'POST', headers, body });
    } catch (e) {
        if (e.proxyError) {
            throw new ConnectionError(
                `Failed to connect to ${baseUrl}. ` +
                    'Enable the CORS proxy in config.yaml (enableCorsProxy: true). ' +
                    `Proxy error: ${e.proxyError.message}. Direct error: ${e.directError.message}`,
                { retryable: true },
            );
        }
        throw new ConnectionError(`Failed to connect to ${baseUrl}: ${e.message}`, {
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
 */
async function readSSEStream(response) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) {
                    continue;
                }

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                    continue;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                    }
                } catch (_e) {
                    /* skip unparseable chunks */
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    return fullContent;
}

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * Streaming avoids the non-streaming token ceiling (4096 on many providers)
 * and allows reasoning models to complete their full thinking + output.
 *
 * Routes through ST's CORS proxy for local endpoints.
 * Cloud endpoints skip the proxy since they have CORS headers.
 * @param {object} params
 * @param {string} params.url - The endpoint base URL
 * @param {string} params.apiKey - The API key
 * @param {string} params.model - The model name
 * @param {string} params.systemPrompt - The system prompt
 * @param {string} params.userPrompt - The user prompt
 * @param {number} [params.maxTokens] - Max tokens for the response
 * @returns {Promise<string>} The generated response content
 */
async function sendViaOpenAI({ url, apiKey, model, systemPrompt, userPrompt, maxTokens }) {
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

    const response = await executeOpenAIFetch(endpoint, useProxy, headers, body, baseUrl);

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

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} - Whether population succeeded
 */
export function populateProfileDropdown(
    /** @type {HTMLSelectElement} */ selectElement,
    currentValue,
) {
    try {
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        console.warn(`${MODULE_NAME} handleDropdown not available.`);
        return false;
    } catch (error) {
        console.error(`${MODULE_NAME} Error populating profile dropdown:`, error);
        return false;
    }
}

/**
 * Get a human-readable name for the current connection source.
 * @param {object} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    switch (settings.connectionSource) {
        case 'default':
            return 'Default (Main API)';
        case 'profile':
            return `Profile: ${settings.connectionProfileId || '(none)'}`;
        case 'ollama':
            return `Ollama: ${settings.ollamaModel || '(no model)'}`;
        case 'openai':
            return `OpenAI: ${settings.openaiModel || '(no model)'}`;
        default:
            return 'Default (Main API)';
    }
}
