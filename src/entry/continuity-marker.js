import { getChat } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { isRecord } from '../core/continuity-state.js';

/**
 * @typedef {object} ContinuityMarks
 * @property {number[]} markedIndices - Chat indices of assistant replies whose extra carries a Continuity Checkpoint payload.
 * @property {number | null} liveIndex - Chat index holding the live Continuity Checkpoint, or null when no reply carries a payload.
 */

/**
 * The Continuity Mark read model: payload presence is the only test, no
 * freshness or coverage math. The live checkpoint is the newest payload
 * message, matching findLiveCheckpoint's back-to-front walk (ADR-0017).
 * @param {ChatMessage[] | unknown} chat
 * @returns {ContinuityMarks}
 */
export function deriveContinuityMarks(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const markedIndices = [];
    let liveIndex = null;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system) {
            continue;
        }
        if (!isRecord(message.extra?.summaryception_continuity)) {
            continue;
        }
        markedIndices.push(index);
        liveIndex = index;
    }
    return { markedIndices, liveIndex };
}

/**
 * Toggle the Continuity Mark classes on the host chat view. Host `mesid`
 * attributes track chat indexes, so every refresh re-derives from data and
 * delete or reorder cannot leave a stale mark.
 * @returns {void}
 */
export function updateContinuityMarker() {
    try {
        const { markedIndices, liveIndex } = deriveContinuityMarks(getChat());
        const marked = new Set(markedIndices);
        $('#chat .mes').each((_index, element) => {
            const $message = $(element);
            const chatIndex = Number($message.attr('mesid'));
            $message.toggleClass('sc_continuity_marked', marked.has(chatIndex));
            $message.toggleClass('sc_continuity_live', chatIndex === liveIndex);
        });
    } catch (e) {
        warn('updateContinuityMarker error:', e);
    }
}
