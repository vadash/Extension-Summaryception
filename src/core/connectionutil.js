/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default: SillyTavern's generateRaw() active connection
 *   - profile: ST Connection Profile via ConnectionManagerRequestService
 *   - ollama: Ollama instance through the ST CORS proxy when needed
 *   - openai: OpenAI-compatible endpoint, streaming supported
 */

import { CONNECTION_MODULE_NAME, ConnectionError } from './connection-error.js';
import { getConnectionManagerRequestService } from '../foundation/context.js';
import { DefaultProvider } from './connection-default.js';
import { OllamaProvider, fetchOllamaModels } from './connection-ollama.js';
import { OpenAIProvider, testOpenAIConnection } from './connection-openai.js';
import { ProfileProvider } from './connection-profile.js';

export { ConnectionError, fetchOllamaModels, testOpenAIConnection };

/**
 * Registered connection providers keyed by settings.connectionSource.
 * @type {Readonly<Record<string, ConnectionProvider>>}
 */
export const providers = Object.freeze({
    default: DefaultProvider,
    profile: ProfileProvider,
    ollama: OllamaProvider,
    openai: OpenAIProvider,
});

/**
 * Send a summarization request using the configured connection.
 * @param {ExtensionSettings} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {AbortSignal} [signal] - Optional request abort signal
 * @returns {Promise<string>} The generated response text
 * @throws {ConnectionError|Error} If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt, signal) {
    const provider = getConnectionProvider(settings.connectionSource);
    return await provider.generate({ settings, systemPrompt, userPrompt, signal });
}

/**
 * Test the configured connection provider.
 * @param {ExtensionSettings} settings
 * @returns {Promise<ConnectionTestResult>}
 */
export async function testSummarizerConnection(settings) {
    const provider = getConnectionProvider(settings.connectionSource);
    return await provider.testConnection(settings);
}

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} Whether population succeeded
 */
export function populateProfileDropdown(
    /** @type {HTMLSelectElement} */ selectElement,
    currentValue,
) {
    try {
        const service = getConnectionManagerRequestService();

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        console.warn(`${CONNECTION_MODULE_NAME} handleDropdown not available.`);
        return false;
    } catch (error) {
        console.error(`${CONNECTION_MODULE_NAME} Error populating profile dropdown:`, error);
        return false;
    }
}

/**
 * Get a human-readable name for the current connection source.
 * @param {ExtensionSettings} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    return getConnectionProvider(settings.connectionSource).displayName(settings);
}

/**
 * Resolve a provider by source, falling back to the default provider.
 * @param {string} [source]
 * @returns {ConnectionProvider}
 */
function getConnectionProvider(source = 'default') {
    return providers[source || 'default'] || providers.default;
}
