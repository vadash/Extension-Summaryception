import { ConnectionError, wrapConnectionError } from './connection-error.js';
import { generateRaw } from '../foundation/context.js';

/**
 * Default SillyTavern active connection adapter.
 * @type {ConnectionProvider}
 */
export const DefaultProvider = {
    async generate({ settings, systemPrompt, userPrompt }) {
        return await sendViaDefault(systemPrompt, userPrompt, settings.summarizerResponseLength);
    },
    displayName(_settings) {
        return 'Default (Main API)';
    },
};

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {number} responseLength - Desired response length
 * @returns {Promise<string>} The generated text
 */
export async function sendViaDefault(systemPrompt, userPrompt, responseLength) {
    /** @type {GenerateRawOptions} */
    const options = {
        prompt: [{ role: 'user', content: userPrompt }],
        systemPrompt,
        trimNames: false,
    };

    if (responseLength && responseLength > 0) {
        options.responseLength = responseLength;
    }

    let result;

    try {
        result = await generateRaw(options);
    } catch (error) {
        if (error?.message?.includes('not available')) {
            throw wrapConnectionError(error, {
                retryable: false,
                message: 'generateRaw is not available in the current SillyTavern context.',
            });
        }
        throw error;
    }

    if (!result || typeof result !== 'string') {
        throw new ConnectionError('generateRaw returned an empty or invalid response.', {
            retryable: true,
        });
    }

    return result;
}
