/**
 * Outgoing-space guard: the main-prompt copy encodes each run of horizontal
 * whitespace as one U+2800 BRAILLE PATTERN BLANK, while summarizer inputs fold
 * both U+2800 and any legacy `$$` form back to spaces (ADR-0036, ADR-0037).
 * The mask is outgoing-only: chat and storage never carry it by construction,
 * but pasted or echoed mask characters still reach the summarizer, so every
 * summarizer-side read folds them back.
 */

import { getActiveModelName } from '../foundation/context.js';

const BRAILLE_BLANK = '\u2800';
const HORIZONTAL_WHITESPACE_RUN = /[\t\p{Zs}]+/gu;
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
 * Fold every U+2800 and every legacy `$$` in each `text` part back to one
 * U+0020. Image URLs and any other part shape stay untouched.
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
 * The Guard Mask model gate: the mask is ENABLED only when the guard toggle
 * is on and the active generation model name carries 'argon', 'opus', or
 * 'gemini' (case-insensitive). The outgoing rewrite in
 * src/core/outgoing-rewrite.js owns the message pass, the Memory Slot skip,
 * and the Preset CoT window; this module keeps the text codec and the gate
 * that the Memory Injection writer and the summarizer paths share.
 * @param {{ guardMask?: unknown }} [settings]
 * @returns {boolean}
 */

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
