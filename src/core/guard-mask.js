/**
 * Outgoing-space guard: the main-prompt copy replaces every U+0020 with `$$`,
 * while summarizer inputs fold any `$$` back to one space (ADR-0036, ADR-0037).
 * The mask is outgoing-only: chat and storage never carry it by construction,
 * but pasted or echoed `$$` still reaches the summarizer, so every
 * summarizer-side read folds it back to one space.
 */

/**
 * Replace every U+0020 with `$$`. The replacer is a function so `$` sequences
 * in the text are inserted literally instead of being read as replacement
 * patterns.
 * @param {string} text
 * @returns {string}
 */
export function maskGuardText(text) {
    return typeof text === 'string' ? text.replaceAll(' ', () => '$$') : text;
}

/**
 * Fold every literal `$$` back to one U+0020.
 * @param {string} text
 * @returns {string}
 */
export function unmaskGuardText(text) {
    return typeof text === 'string' ? text.replaceAll('$$', ' ') : text;
}

/**
 * Replace every U+0020 in outgoing user and assistant message content with `$$`.
 * Speaker names, tool payloads, and system or developer blocks stay untouched.
 * The Memory slot keeps its own gate in memory-injection.js: buildInjection masks
 * the slot text when memory masking is on. When that gate is off, the caller
 * passes the unmasked slot text as `skipContent` so this pass leaves it alone.
 * Runs last at the GENERATE_AFTER_DATA seam, after the user-role rewrite.
 * @param {Array<{ role?: unknown, content?: unknown }> | null} messages
 * @param {{ enabled?: unknown, guardMask?: unknown }} [settings]
 * @param {string | null} [skipContent] - Exact message content to leave unmasked.
 * @returns {void}
 */
export function maskGuardContent(messages, settings = {}, skipContent = null) {
    if (!Array.isArray(messages) || !settings.enabled || !settings.guardMask) {
        return;
    }
    for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') {
            continue;
        }
        if (typeof message.content !== 'string') {
            continue;
        }
        if (skipContent !== null && message.content === skipContent) {
            continue;
        }
        message.content = maskGuardText(message.content);
    }
}
