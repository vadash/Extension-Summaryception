import { ConnectionError } from './connection-error.js';
import { fetchWithProxyFallback, readErrorText } from './connection-transport.js';

/**
 * Ollama chat API adapter.
 * @type {ConnectionProvider}
 */
export const OllamaProvider = {
    async generate({ settings, systemPrompt, userPrompt }) {
        return await sendViaOllama(
            settings.ollamaUrl,
            settings.ollamaModel,
            systemPrompt,
            userPrompt,
        );
    },
    async testConnection(settings) {
        return await testOllamaConnection(settings.ollamaUrl, settings.ollamaModel);
    },
    displayName(settings) {
        return `Ollama: ${settings.ollamaModel || '(no model)'}`;
    },
};

/**
 * Send a request to a local Ollama instance using /api/chat.
 * @param {string} url - The Ollama base URL
 * @param {string} model - The model name
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} The generated response content
 */
export async function sendViaOllama(url, model, systemPrompt, userPrompt) {
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

/**
 * Test an Ollama endpoint and selected model.
 * @param {string} url
 * @param {string} model
 * @returns {Promise<ConnectionTestResult>}
 */
export async function testOllamaConnection(url, model) {
    try {
        if (!model) {
            throw new Error('Ollama model is not selected.');
        }
        const models = await fetchOllamaModels(url);
        const hasModel = models.some((entry) => entry.name === model);
        if (!hasModel) {
            return {
                success: false,
                message: `Ollama is reachable, but model "${model}" was not found.`,
            };
        }
        return {
            success: true,
            message: `Ollama connection successful. Model "${model}" is available.`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Ollama connection failed: ${error.message}`,
        };
    }
}
