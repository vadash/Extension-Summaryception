import { ConnectionError } from './connection-error.js';

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * @param {string} profileId - The connection profile identifier
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} The generated response content
 */
export async function sendViaProfile(profileId, systemPrompt, userPrompt) {
    if (!profileId) {
        throw new ConnectionError(
            'No Connection Profile selected. Please select one in Summaryception settings.',
            { retryable: false },
        );
    }

    const service = getProfileRequestService();

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
 * Get SillyTavern's validated profile request service.
 * @returns {{ sendRequest: Function }}
 */
function getProfileRequestService() {
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

    return service;
}

/**
 * Extract content from a `choices[0].message.content` structure.
 * @param {Array<Record<string, unknown>>} choices
 * @returns {string|null} The content string, or null if not found
 */
function extractChoiceContent(choices) {
    const choice = choices[0];
    if (!choice?.message || typeof choice.message !== 'object') {
        return null;
    }
    const msg = /** @type {Record<string, unknown>} */ (choice.message);
    return typeof msg.content === 'string' ? msg.content : null;
}

/**
 * Extract content from a `message.content` wrapper.
 * @param {Record<string, unknown>} obj
 * @returns {string|null} The content string, or null if not found
 */
function extractMessageContent(obj) {
    if (!obj.message || typeof obj.message !== 'object') {
        return null;
    }
    const content = /** @type {Record<string, unknown>} */ (obj.message).content;
    return typeof content === 'string' ? content : null;
}

/**
 * Extract content from a `data` field.
 * @param {Record<string, unknown>} obj
 * @returns {string|null} The data string, or null if absent
 */
function extractDataField(obj) {
    if (obj.data === null || obj.data === undefined) {
        return null;
    }
    return typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data);
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

    const messageContent = extractMessageContent(obj);
    if (messageContent) {
        return messageContent;
    }

    if (Array.isArray(obj.choices)) {
        const choiceContent = extractChoiceContent(obj.choices);
        if (choiceContent) {
            return choiceContent;
        }
    }

    const dataContent = extractDataField(obj);
    if (dataContent) {
        return dataContent;
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
