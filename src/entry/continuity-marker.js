import { getChat } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { deriveContinuityMarks } from '../core/continuity-coverage.js';

/**
 * Toggle the Continuity Mark classes on the host chat view. A DOM adapter over
 * the Continuity Coverage marks (ADR-0022): it renders what
 * deriveContinuityMarks derives and never walks the chat itself. Host `mesid`
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
