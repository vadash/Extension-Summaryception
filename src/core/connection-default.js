import { ConnectionError, wrapConnectionError } from './connection-error.js';
import { generateRaw } from '../foundation/context.js';

/**
 * Default SillyTavern active connection adapter.
 * @type {ConnectionProvider}
 */
export const DefaultProvider = {
    // Cancellable is false because host generateRaw() takes no AbortSignal
    // parameter. Timeout and Stop can only abandon the orphaned HTTP request.
    // Forward the signal when SillyTavern's GenerateRawParams gains one.
    cancellable: false,
    async generate({ settings, systemPrompt, userPrompt, recall }) {
        return await sendViaDefault(
            systemPrompt,
            userPrompt,
            settings.summarizerResponseLength,
            recall,
        );
    },
};

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 * @param {string} systemPrompt
 * @param {string} userPrompt - The payload message
 * @param {number} responseLength
 * @param {string} [recall] - The recall message; appended as the last user turn
 * @returns {Promise<string>}
 */
export async function sendViaDefault(systemPrompt, userPrompt, responseLength, recall = '') {
    /** @type {GenerateRawOptions} */
    const options = {
        prompt: buildRequestMessages(userPrompt, recall),
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

/**
 * The user turns of one request: the payload, then the recall message when the
 * call family carries one.
 * @param {string} userPrompt
 * @param {string} [recall]
 * @returns {Array<{ role: 'user', content: string }>}
 */
function buildRequestMessages(userPrompt, recall) {
    /** @type {Array<{ role: 'user', content: string }>} */
    const messages = [{ role: 'user', content: userPrompt }];
    if (recall) {
        messages.push({ role: 'user', content: recall });
    }
    return messages;
}
