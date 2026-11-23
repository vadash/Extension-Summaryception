/**
 * Outgoing-space guard: the main-prompt copy encodes each run of horizontal
 * whitespace as one U+2800 BRAILLE PATTERN BLANK, while summarizer inputs fold
 * both U+2800 and any legacy `$$` form back to spaces (ADR-0036, ADR-0037).
 * The mask is outgoing-only: chat and storage never carry it by construction,
 * but pasted or echoed mask characters still reach the summarizer, so every
 * summarizer-side read folds them back.
 */

import {
    GUARD_MASK_COT_AUTO_COUNT,
    GUARD_MASK_COT_MODES,
    SLIDER_LIMITS,
} from '../foundation/constants.js';
import { getActiveModelName, getChat } from '../foundation/context.js';
import { clampInteger } from '../foundation/numeric.js';

const BRAILLE_BLANK = '\u2800';
const HORIZONTAL_WHITESPACE_RUN = /[^\S\r\n]+/g;
const MASKED_SPACE = /\$\$|\u2800/g;

/**
 * Replace each run of horizontal whitespace with one U+2800 BRAILLE PATTERN
 * BLANK. Newlines survive untouched, an existing U+2800 stays as-is so a
 * second pass changes nothing, and letters are never split.
 * @param {string} text
 * @returns {string}
 */
export function maskGuardText(text) {
    return typeof text === 'string' ? text.replace(HORIZONTAL_WHITESPACE_RUN, BRAILLE_BLANK) : text;
}

/**
 * Fold every U+2800 and every legacy `$$` back to one U+0020 each.
 * @param {string} text
 * @returns {string}
 */
export function unmaskGuardText(text) {
    return typeof text === 'string' ? text.replace(MASKED_SPACE, ' ') : text;
}

/**
 * Mask every `text` part of a multipart content array. Image URLs and any
 * other part shape stay untouched.
 * @param {unknown} content - Message content array.
 * @returns {void}
 */
export function unmaskGuardContentParts(content) {
    if (!Array.isArray(content)) {
        return;
    }
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const entry = /** @type {{ type?: unknown, text?: unknown }} */ (part);
        if (entry.type !== 'text' || typeof entry.text !== 'string') {
            continue;
        }
        entry.text = unmaskGuardText(entry.text);
    }
}

/**
 * Mask every `text` part of a multipart content array. Image URLs and any
 * other part shape stay untouched.
 * @param {unknown} content - Message content array.
 * @returns {void}
 */
export function maskGuardContentParts(content) {
    if (!Array.isArray(content)) {
        return;
    }
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const entry = /** @type {{ type?: unknown, text?: unknown }} */ (part);
        if (entry.type !== 'text' || typeof entry.text !== 'string') {
            continue;
        }
        entry.text = maskGuardText(entry.text);
    }
}

/**
 * The Guard Mask model gate: the mask is ENABLED only when the extension and
 * the guard toggle are on and the active generation model name carries
 * 'argon', 'opus', or 'gemini' (case-insensitive). Every other state is
 * DISABLED. ENABLED encodes each run of horizontal whitespace in outgoing user
 * and assistant message content as one U+2800 BRAILLE PATTERN BLANK; DISABLED
 * folds every U+2800 and every legacy `$$` in that content back to one space,
 * so a pasted or echoed mask never leaks through behind a non-matching model.
 * Speaker names, tool payloads, and system or developer blocks stay untouched
 * either way. The Memory slot keeps its own gate in memory-injection.js:
 * buildInjection masks the slot text when memory masking is on. When that gate
 * is off, the caller passes the unmasked slot text as `skipContent` so this
 * pass leaves it alone. Trailing user-role Preset CoT messages after the last
 * chat message stay unmasked up to the configured window. Runs last at the
 * GENERATE_AFTER_DATA seam, after the user-role rewrite.
 * @param {Array<{ role?: unknown, content?: unknown }> | null} messages
 * @param {{ enabled?: unknown, guardMask?: unknown, guardMaskCotMode?: unknown, guardMaskCotCount?: unknown }} [settings]
 * @param {string | null} [skipContent] - Exact message content to leave unmasked.
 * @returns {void}
 */
export function maskGuardContent(messages, settings = {}, skipContent = null) {
    if (!Array.isArray(messages) || !settings.enabled) {
        return;
    }
    if (isGuardMaskEnabled(settings)) {
        applyGuardMask(messages, settings, skipContent);
        return;
    }
    applyGuardUnmask(messages);
}

/**
 * ENABLED branch: mask user and assistant content except the trailing Preset
 * CoT window and the raw Memory slot copy.
 * @param {Array<{ role?: unknown, content?: unknown }>} messages
 * @param {{ guardMaskCotMode?: unknown, guardMaskCotCount?: unknown }} settings
 * @param {string | null} skipContent - Exact message content to leave unmasked.
 * @returns {void}
 */
function applyGuardMask(messages, settings, skipContent) {
    const exempt = collectPresetCotExemptions(messages, settings);
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== 'user' && message.role !== 'assistant') {
            continue;
        }
        if (exempt.has(index)) {
            continue;
        }
        if (skipContent !== null && message.content === skipContent) {
            continue;
        }
        if (typeof message.content === 'string') {
            message.content = maskGuardText(message.content);
            continue;
        }
        maskGuardContentParts(message.content);
    }
}

/**
 * DISABLED branch: fold every U+2800 and every legacy `$$` in user and
 * assistant content back to one space each. No exemptions and no slot skip:
 * pasted or echoed mask characters must not survive behind a non-matching
 * model.
 * @param {Array<{ role?: unknown, content?: unknown }>} messages
 * @returns {void}
 */
function applyGuardUnmask(messages) {
    for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant') {
            continue;
        }
        if (typeof message.content === 'string') {
            message.content = unmaskGuardText(message.content);
            continue;
        }
        unmaskGuardContentParts(message.content);
    }
}

/**
 * ENABLED only when the guard toggle is on and the active generation model
 * name carries 'argon', 'opus', or 'gemini'. Unknown or unreadable models read
 * DISABLED.
 * @param {{ guardMask?: unknown }} [settings]
 * @returns {boolean}
 */
export function isGuardMaskEnabled(settings = {}) {
    if (!settings.guardMask) {
        return false;
    }
    return /argon|opus|gemini/i.test(getActiveModelName());
}

/**
 * Message indexes in the trailing Preset CoT window. The anchor is the live
 * chat's last message; a miss exempts nothing because the unseen tail may be
 * chat content. Only user-role messages after the anchor count toward N.
 * @param {Array<{ role?: unknown, content?: unknown }>} messages
 * @param {{ guardMaskCotMode?: unknown, guardMaskCotCount?: unknown }} settings
 * @returns {Set<number>}
 */
function collectPresetCotExemptions(messages, settings) {
    const count = resolvePresetCotCount(settings);
    if (count === 0) {
        return new Set();
    }
    const anchorIndex = findLastChatMessageIndex(messages);
    if (anchorIndex === -1) {
        return new Set();
    }
    const exempt = new Set();
    for (let index = anchorIndex + 1; index < messages.length && exempt.size < count; index++) {
        if (messages[index].role === 'user') {
            exempt.add(index);
        }
    }
    return exempt;
}

/**
 * Auto resolves to the fixed window, on clamps the slider, and off disables the
 * exemption. An unknown mode falls back to auto, the shipped default.
 * @param {{ guardMaskCotMode?: unknown, guardMaskCotCount?: unknown }} settings
 * @returns {number}
 */
function resolvePresetCotCount(settings) {
    const mode =
        settings.guardMaskCotMode === GUARD_MASK_COT_MODES.OFF ||
        settings.guardMaskCotMode === GUARD_MASK_COT_MODES.ON
            ? settings.guardMaskCotMode
            : GUARD_MASK_COT_MODES.AUTO;
    if (mode === GUARD_MASK_COT_MODES.OFF) {
        return 0;
    }
    if (mode === GUARD_MASK_COT_MODES.AUTO) {
        return GUARD_MASK_COT_AUTO_COUNT;
    }
    const { MIN, MAX } = SLIDER_LIMITS.guardMaskCotCount;
    return clampInteger(settings.guardMaskCotCount, MIN, MAX);
}

/**
 * The last chat message's prompt index, matched from the tail backward.
 * @param {Array<{ content?: unknown }>} messages
 * @returns {number} Index, or -1 when the live chat's last message is absent.
 */
function findLastChatMessageIndex(messages) {
    const chat = readLiveChat();
    const last = /** @type {{ mes?: unknown } | undefined} */ (
        chat ? chat[chat.length - 1] : undefined
    );
    const anchor = normalizeAnchorText(messageText(last?.mes));
    if (!anchor) {
        return -1;
    }
    for (let index = messages.length - 1; index >= 0; index--) {
        if (matchesAnchor(messageText(messages[index].content), anchor)) {
            return index;
        }
    }
    return -1;
}

/**
 * A missing runtime is an anchor miss, which masks everything.
 * @returns {unknown[] | null}
 */
function readLiveChat() {
    try {
        const chat = getChat();
        return Array.isArray(chat) ? chat : null;
    } catch (_e) {
        return null;
    }
}

/**
 * Text a message carries for anchor comparison. A multipart message is one
 * message: its text parts join back into one compare string.
 * @param {unknown} content
 * @returns {string}
 */
function messageText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    let text = '';
    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const entry = /** @type {{ type?: unknown, text?: unknown }} */ (part);
        if (entry.type === 'text' && typeof entry.text === 'string') {
            text += entry.text;
        }
    }
    return text;
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeAnchorText(text) {
    return text.replaceAll('\r', '').trim();
}

/**
 * Exact match after normalization, or the same text behind one speaker-name
 * prefix such as `Player1: `.
 * @param {string} content
 * @param {string} anchor
 * @returns {boolean}
 */
function matchesAnchor(content, anchor) {
    const candidate = normalizeAnchorText(content);
    if (candidate === anchor) {
        return true;
    }
    if (!candidate.endsWith(anchor)) {
        return false;
    }
    const prefix = candidate.slice(0, candidate.length - anchor.length);
    return /^[^:\n]{1,80}:\s+$/.test(prefix);
}
