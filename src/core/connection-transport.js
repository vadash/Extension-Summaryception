/**
 * Extract text from common chat-completion response wrappers.
 * @param {unknown} responseObj
 * @returns {string|null}
 */
export function tryExtractChatContent(responseObj) {
    if (responseObj === null || responseObj === undefined || typeof responseObj !== 'object') {
        return null;
    }

    const obj = /** @type {{ content?: unknown, message?: unknown, choices?: unknown }} */ (
        responseObj
    );
    if (typeof obj.content === 'string') {
        return obj.content;
    }

    const messageContent = extractContentProperty(obj.message);
    if (messageContent !== null) {
        return messageContent;
    }

    if (!Array.isArray(obj.choices)) {
        return null;
    }

    const choice = /** @type {{ message?: unknown, delta?: unknown } | undefined} */ (
        obj.choices[0]
    );
    return extractContentProperty(choice?.message) ?? extractContentProperty(choice?.delta);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function extractContentProperty(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const content = /** @type {{ content?: unknown }} */ (value).content;
    return typeof content === 'string' ? content : null;
}
