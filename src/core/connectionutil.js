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
import { sendViaDefault } from './connection-default.js';
import { fetchOllamaModels, sendViaOllama } from './connection-ollama.js';
import { sendViaOpenAI, testOpenAIConnection } from './connection-openai.js';
import { sendViaProfile } from './connection-profile.js';

export { ConnectionError, fetchOllamaModels, testOpenAIConnection };

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} The generated response text
 * @throws {ConnectionError|Error} If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt) {
    const source = settings.connectionSource || 'default';

    switch (source) {
        case 'profile':
            return await sendViaProfile(
                settings.connectionProfileId,
                systemPrompt,
                userPrompt,
                settings.summarizerResponseLength,
            );
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
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;

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
