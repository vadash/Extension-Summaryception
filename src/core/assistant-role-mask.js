/**
 * Rewrite final chat-completion request roles without touching persisted chat state.
 */

/**
 * Synthetic user block prepended when masking would otherwise remove every
 * user role from the outgoing payload. Required by APIs that reject requests
 * with zero user messages.
 */
const COMPATIBILITY_MARKER_CONTENT = '[user-role compatibility marker]';

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

    const maskableMessages = [];
    let userMessageCount = 0;
    for (const message of messages) {
        if (message.role !== 'user') {
            continue;
        }
        userMessageCount++;
        if (shouldMaskMessage(message)) {
            maskableMessages.push(message);
        }
    }

    let rewritten = 0;

    if (userMessageCount > 0 && maskableMessages.length === userMessageCount) {
        messages.unshift({
            role: 'user',
            content: COMPATIBILITY_MARKER_CONTENT,
        });
    }

    for (const message of maskableMessages) {
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
