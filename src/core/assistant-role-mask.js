/**
 * Rewrite final chat-completion request roles without touching persisted chat state.
 * The Guard Mask (ADR-0036) rides this same seam: it replaces every U+0020 with
 * `$$` in the outgoing user and assistant message content, last step after the
 * role rewrite, when the guard settings are on.
 */

import { isPlainObject } from '../foundation/objects.js';
import { isTraceEnabled } from '../foundation/logger.js';
import { LOG_PREFIX, MASK_USER_ROLE_MODES } from '../foundation/constants.js';
import { maskGuardContent } from './guard-mask.js';

/**
 * Synthetic user block for the compatibility modes. Some APIs reject
 * requests with zero user messages.
 */
const COMPATIBILITY_MARKER_CONTENT = '[user-role compatibility marker]';

/**
 * Rewrite the outgoing roles and then apply the outgoing-space guard. The guard
 * runs last so it sees the rewritten roles, and it runs even when the role mask
 * is off because the two settings are independent.
 * @param {unknown} generateData - Mutable SillyTavern GENERATE_AFTER_DATA payload.
 * @param {Partial<ExtensionSettings>} settings - Effective Summaryception settings.
 * @returns {number}
 */
export function maskUserRoleAsAssistantInGenerateData(generateData, settings = {}) {
    const messages = getPromptMessages(generateData);
    const rewritten = rewriteUserRoles(messages, settings);
    applyGuardMask(messages, settings);
    return rewritten;
}

/**
 * @param {Array<Record<string, unknown>> | null} messages
 * @param {Partial<ExtensionSettings>} settings
 * @returns {number}
 */
function rewriteUserRoles(messages, settings) {
    if (!messages || !settings.enabled || !settings.maskUserRoleAsAssistant) {
        return 0;
    }

    const userMessages = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === 'user') {
            userMessages.push({ index, message });
        }
    }
    if (userMessages.length === 0) {
        logRoleMaskDebug({
            mode: normalizeMaskMode(settings.maskUserRoleMode),
            userMessages: [],
            preservedMessage: null,
            rewritten: 0,
        });
        return 0;
    }

    const mode = normalizeMaskMode(settings.maskUserRoleMode);
    if (mode === MASK_USER_ROLE_MODES.MARKER_FIRST) {
        messages.unshift({
            role: 'user',
            content: COMPATIBILITY_MARKER_CONTENT,
        });
    }

    const preservedMessage =
        mode === MASK_USER_ROLE_MODES.KEEP_LAST_USER
            ? userMessages[userMessages.length - 1].message
            : null;
    let rewritten = 0;
    for (const entry of userMessages) {
        const message = entry.message;
        if (message === preservedMessage) {
            continue;
        }
        message.role = 'assistant';
        rewritten++;
    }

    if (mode === MASK_USER_ROLE_MODES.MARKER_LAST) {
        messages.push({
            role: 'user',
            content: COMPATIBILITY_MARKER_CONTENT,
        });
    }

    logRoleMaskDebug({ mode, userMessages, preservedMessage, rewritten });

    return rewritten;
}

/**
 * Replace every U+0020 in outgoing user and assistant content with `$$`.
 * Speaker names, tool payloads, and system or developer blocks stay untouched.
 * @param {Array<Record<string, unknown>> | null} messages
 * @param {Partial<ExtensionSettings>} settings
 * @returns {void}
 */
function applyGuardMask(messages, settings) {
    maskGuardContent(messages, settings);
}

function normalizeMaskMode(value) {
    const mode = String(value || '');
    const validModes = /** @type {string[]} */ (Object.values(MASK_USER_ROLE_MODES));
    return validModes.includes(mode) ? mode : MASK_USER_ROLE_MODES.MARKER_FIRST;
}

function logRoleMaskDebug({ mode, userMessages, preservedMessage, rewritten }) {
    if (!isTraceEnabled()) {
        return;
    }

    const kept = userMessages.length - rewritten;
    console.groupCollapsed(
        `${LOG_PREFIX} [TRACE] User role mask: changed=${rewritten}, kept=${kept}, mode=${mode}`,
    );
    try {
        console.log(
            userMessages.map(({ index, message }) => ({
                index,
                action: message === preservedMessage ? 'kept' : 'changed',
                preview: previewMessageContent(message.content),
            })),
        );
    } finally {
        console.groupEnd();
    }
}

function previewMessageContent(content) {
    let text;
    if (typeof content === 'string') {
        text = content;
    } else {
        try {
            text = JSON.stringify(content);
        } catch (_e) {
            text = String(content ?? '');
        }
    }
    const compact = String(text || '')
        .replaceAll(/\s+/g, ' ')
        .trim();
    return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
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
