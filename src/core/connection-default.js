import { ConnectionError } from './connection-error.js';

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {number} responseLength - Desired response length
 * @returns {Promise<string>} The generated text
 */
export async function sendViaDefault(systemPrompt, userPrompt, responseLength) {
    const { generateRaw } = SillyTavern.getContext();

    if (!generateRaw) {
        throw new ConnectionError(
            'generateRaw is not available in the current SillyTavern context.',
            { retryable: false },
        );
    }

    let result;

    if (generateRaw.length <= 1) {
        const options = {
            prompt: [{ role: 'user', content: userPrompt }],
            systemPrompt,
            trimNames: false,
        };

        if (responseLength && responseLength > 0) {
            options.responseLength = responseLength;
        }

        result = await generateRaw(options);
    } else {
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
