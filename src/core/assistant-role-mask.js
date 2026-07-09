/**
 * Rewrite final chat-completion request roles without touching persisted chat state.
 */

/**
 * Apply the assistant-role mask to a SillyTavern generation payload.
 * @param {unknown} generateData - Mutable SillyTavern GENERATE_AFTER_DATA payload.
 * @param {Partial<ExtensionSettings>} settings - Effective Summaryception settings.
 * @returns {number} Number of messages rewritten.
 */
export function maskUserRoleAsAssistantInGenerateData(generateData, settings = {}) {
    if (!settings.enabled || !settings.maskUserRoleAsAssistant) {
        return 0;
    }

    const messages = getPromptMessages(generateData);
    if (!messages) {
        return 0;
    }

    let rewritten = 0;
    for (const message of messages) {
        if (!shouldMaskMessage(message)) {
            continue;
        }
        message.role = 'assistant';
        rewritten++;
    }
    return rewritten;
}

/**
 * @param {unknown} generateData
 * @returns {Array<Record<string, unknown>> | null}
 */
function getPromptMessages(generateData) {
    if (Array.isArray(generateData)) {
        return getObjectArray(generateData);
    }
    if (!isPlainObject(generateData)) {
        return null;
    }
    const prompt = generateData.prompt;
    if (Array.isArray(prompt)) {
        return getObjectArray(prompt);
    }
    const messages = generateData.messages;
    if (Array.isArray(messages)) {
        return getObjectArray(messages);
    }
    return null;
}

/**
 * @param {unknown[]} values
 * @returns {Array<Record<string, unknown>> | null}
 */
function getObjectArray(values) {
    return values.every(isPlainObject) ? values : null;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function shouldMaskMessage(message) {
    return (
        message.role === 'user' &&
        !message.tool_calls &&
        !message.tool_call_id &&
        isTextOnlyContent(message.content)
    );
}

/**
 * @param {unknown} content
 * @returns {boolean}
 */
function isTextOnlyContent(content) {
    if (typeof content === 'string') {
        return true;
    }
    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }
    return content.every(isTextContentPart);
}

/**
 * @param {unknown} part
 * @returns {boolean}
 */
function isTextContentPart(part) {
    if (typeof part === 'string') {
        return true;
    }
    return isPlainObject(part) && part.type === 'text';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
