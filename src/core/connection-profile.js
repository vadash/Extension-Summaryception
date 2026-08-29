import { ConnectionError, wrapConnectionError } from './connection-error.js';
import { tryExtractChatContent } from './connection-transport.js';
import { getConnectionManagerRequestService } from '../foundation/context.js';
import { trace, warn } from '../foundation/logger.js';

/**
 * SillyTavern Connection Profile adapter.
 * @type {ConnectionProvider}
 */
export const ProfileProvider = {
    async generate({ settings, systemPrompt, userPrompt, signal }) {
        return await sendViaProfile({
            profileId: settings.connectionProfileId,
            systemPrompt,
            userPrompt,
            maxTokens: settings.summarizerResponseLength,
            signal,
        });
    },
    displayName(settings) {
        return `Profile: ${settings.connectionProfileId || '(none)'}`;
    },
};

/**
 * @typedef {object} ProfileRequestParams
 * @property {string} profileId - The connection profile identifier
 * @property {string} systemPrompt - The system prompt
 * @property {string} userPrompt - The user prompt
 * @property {number} [maxTokens] - Max tokens for the response, or 0 to use the profile preset
 * @property {AbortSignal} [signal] - Optional request abort signal
 */

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * @param {ProfileRequestParams} params
 * @returns {Promise<string>} The generated response content
 */
export async function sendViaProfile({
    profileId,
    systemPrompt,
    userPrompt,
    maxTokens = 0,
    signal,
}) {
    if (!profileId) {
        throw new ConnectionError(
            'No Connection Profile selected. Please select one in Summaryception settings.',
            { retryable: false },
        );
    }

    const service = getProfileRequestService();

    try {
        /** @type {ConnectionProfileMessage[]} */
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const tokenLimit = maxTokens && maxTokens > 0 ? maxTokens : undefined;
        const raw = await service.sendRequest(profileId, messages, tokenLimit, {
            includePreset: false,
            includeInstruct: false,
            ...(signal ? { signal } : {}),
        });

        trace('[Connection] Profile sendRequest returned:', typeof raw, raw);

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
 * Get SillyTavern's validated profile request service.
 * @returns {ConnectionManagerRequestService}
 */
function getProfileRequestService() {
    const service = getConnectionManagerRequestService();

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

    return service;
}

/**
 * Extract content from a `data` field.
 * @param {ConnectionProfileResponse} obj
 * @returns {string|null} The data string, or null if absent
 */
function extractDataField(obj) {
    if (obj.data === null || obj.data === undefined) {
        return null;
    }
    if (typeof obj.data === 'string') {
        return obj.data;
    }
    const serialized = JSON.stringify(obj.data);
    return typeof serialized === 'string' ? serialized : null;
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

    if (raw === null || raw === undefined || typeof raw !== 'object') {
        throw new ConnectionError('Connection Profile returned an empty or invalid response.', {
            retryable: true,
        });
    }

    const obj = /** @type {ConnectionProfileResponse} */ (raw);

    const chatContent = tryExtractChatContent(obj);
    if (chatContent !== null) {
        return chatContent;
    }

    const dataContent = extractDataField(obj);
    if (dataContent) {
        return dataContent;
    }

    if (raw !== null && raw !== undefined && typeof raw === 'object') {
        const str = JSON.stringify(raw);
        warn('[Connection] Unexpected return type from sendRequest:', str.substring(0, 500));
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

    throw wrapConnectionError(error, { profileId }, 'Connection Profile');
}
