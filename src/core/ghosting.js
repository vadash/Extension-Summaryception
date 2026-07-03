import { LOG_PREFIX } from '../foundation/constants.js';
import { getChatStore, getSettings, saveChatStore } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { isPromptMutationFrozen } from './summarizer-commit.js';

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
/**
 * Check if a message should be skipped during ghost repair.
 * @param {object} m - The chat message
 * @param {boolean} isGhosted - Whether the message is already ghosted by us
 * @returns {boolean} True if the message should be skipped
 */
function skipRepairGhost(m, isGhosted) {
    if (!m) {
        return true;
    }
    if (isGhosted) {
        return true;
    }
    if (m.is_hidden && !isGhosted) {
        return true;
    }
    if (m.is_system || !m.mes?.trim()) {
        return true;
    }
    if (m.is_user) {
        return true;
    }
    return false;
}

/**
 * Ensure all messages in a range are ghosted (hidden from LLM).
 * @param {number} startIdx - Start index in chat
 * @param {number} endIdx - End index in chat
 * @returns {Promise<number>} Number of messages newly ghosted
 */
export async function repairGhostingForRange(startIdx, endIdx) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);

    if (isPromptMutationFrozen()) {
        log('Ghost repair deferred while foreground generation is active.');
        return 0;
    }

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        const isGhosted = m?.extra?.sc_ghosted === true;

        if (skipRepairGhost(m, isGhosted)) {
            if (m?.is_hidden && !isGhosted) {
                trace(' Skipping message ' + i + ' - user-hidden');
            }
            skipped++;
            continue;
        }

        trace(' Ghosting message ' + i);
        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, {
                    showOutput: false,
                });
                repaired++;
            } catch (e) {
                console.error(LOG_PREFIX, 'Failed to ghost message ' + i + ':', e);
            }
        } else {
            repaired++;
        }
    }

    trace(' Repaired:', repaired, 'Skipped:', skipped);
    await saveChatStore();
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

/**
 * Ghost a single message by index.
 * @param {number} messageIndex - The chat index to ghost
 * @returns {Promise<void>}
 */
export async function ghostMessage(messageIndex) {
    if (isPromptMutationFrozen()) {
        log(`Ghosting deferred for message ${messageIndex}; foreground generation is active.`);
        return;
    }

    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) {
        return;
    }
    if (!msg.extra) {
        msg.extra = {};
    }
    if (msg.extra.sc_ghosted) {
        return;
    }

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    if (!store.ghostedIndices.includes(messageIndex)) {
        store.ghostedIndices.push(messageIndex);
    }

    // Only visually hide if ghosting is enabled
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(
                `/hide ${messageIndex}`,
                { showOutput: false },
            );
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
}

/**
 * Collect indices of messages that we ghosted.
 * @param {Array} chat - The chat array
 * @param {object} store - The chat store
 * @returns {number[]} Indices to unhide
 */
function collectGhostedIndices(chat, store) {
    if (store.ghostedIndices && store.ghostedIndices.length > 0) {
        return [...store.ghostedIndices];
    }
    const result = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted) {
            result.push(i);
        }
    }
    return result;
}

/**
 * Update the progress toast at regular intervals.
 * @param {object} progressToast - The toastr toast object
 * @param {number} processed - Number processed so far
 * @param {number} total - Total to process
 */
function updateUnhideProgress(progressToast, processed, total) {
    if (processed % 10 !== 0) {
        return;
    }
    const pct = Math.round((processed / total) * 100);
    $(progressToast)
        .find('.toast-message')
        .text(`Unhiding messages: ${processed} / ${total} (${pct}%)`);
}

/**
 * Unghost all messages that Summaryception ghosted.
 * @returns {Promise<void>}
 */
export async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const toUnhide = collectGhostedIndices(chat, store);

    if (toUnhide.length === 0) {
        return;
    }

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${toUnhide.length}`,
        'Summaryception — Clearing',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        },
    );

    let processed = 0;
    for (const idx of toUnhide) {
        if (idx >= 0 && idx < chat.length && chat[idx]?.extra?.sc_ghosted) {
            delete chat[idx].extra.sc_ghosted;
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${idx}`, {
                    showOutput: false,
                });
            } catch (e) {
                log(`Failed to unhide message ${idx}:`, e);
            }
        }
        processed++;
        updateUnhideProgress(progressToast, processed, toUnhide.length);
    }

    store.ghostedIndices = [];
    toastr.clear(progressToast);
    log(`Unghosted ${toUnhide.length} messages (only Summaryception-hidden ones)`);
}

/**
 * Update the ghosting progress toast.
 * @param {object} progressToast - The toastr toast object
 * @param {number} current - Current index
 * @param {number} total - Total indices
 */
function updateHideProgress(progressToast, current, total) {
    const pct = Math.round((current / total) * 100);
    $(progressToast)
        .find('.toast-message')
        .text(`Hiding messages: ${current} / ${total} (${pct}%)`);
}

/**
 * Determine if a message should be skipped during ghosting.
 * @param {object} msg - The chat message
 * @param {boolean} isSystemGhosted - Whether this is a system msg we already ghosted
 * @returns {boolean} True if the message should be skipped
 */
function shouldSkipGhosting(msg, isSystemGhosted) {
    if (!msg) {
        return true;
    }
    if (msg.is_system && !isSystemGhosted) {
        return true;
    }
    if (msg.is_hidden) {
        return true;
    }
    return false;
}

/**
 * Record a single message as ghosted in memory (metadata + store tracking).
 * @param {object} msg - The chat message
 * @param {number} i - The message index
 */
function markGhosted(msg, i) {
    if (!msg.extra) {
        msg.extra = {};
    }
    msg.extra.sc_ghosted = true;
    const store = getChatStore();
    if (!store.ghostedIndices.includes(i)) {
        store.ghostedIndices.push(i);
    }
}

/**
 * Ghost a single message by index, respecting the disableGhosting setting.
 * @param {object} msg - The chat message
 * @param {number} i - The message index
 * @returns {Promise<void>}
 */
async function applyGhostToMessage(msg, i) {
    markGhosted(msg, i);
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, {
                showOutput: false,
            });
        } catch (e) {
            log(`Failed to hide message ${i}:`, e);
        }
    }
}

/**
 * Ghost all messages from index 0 up to and including endIndex.
 * @param {number} endIndex - The highest index to ghost
 * @returns {Promise<void>}
 */
export async function ghostMessagesUpTo(endIndex) {
    if (isPromptMutationFrozen()) {
        log(`Ghosting up to ${endIndex} deferred; foreground generation is active.`);
        return;
    }

    const { chat } = SillyTavern.getContext();
    const s = getSettings();

    const progressToast = !s.disableGhosting
        ? toastr.info(`Hiding messages: 0 / ${endIndex + 1}`, 'Summaryception — Ghosting', {
              timeOut: 0,
              extendedTimeOut: 0,
              tapToDismiss: false,
          })
        : null;

    let processed = 0;
    for (let i = 0; i <= endIndex; i++) {
        const msg = chat[i];
        const ghosted = msg?.extra?.sc_ghosted === true;

        if (shouldSkipGhosting(msg, ghosted)) {
            if (msg?.is_hidden) {
                log(`Skipping message ${i} — already hidden by user`);
            }
            continue;
        }

        await applyGhostToMessage(msg, i);

        processed++;
        if (progressToast && processed % 10 === 0) {
            updateHideProgress(progressToast, i, endIndex + 1);
        }
    }

    if (progressToast) {
        toastr.clear(progressToast);
    }
    log(
        `Ghosted messages from index 0 to ${endIndex}${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`,
    );
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect if the current chat was branched before the summarized point.
 * When ST creates a branch at message N, it copies messages 0..N into a new chat file.
 * But chatMetadata (including our store) is copied as-is, so summarizedUpTo might
 * point beyond the end of the new chat, and snippets may reference turns that
 * no longer exist in this branch.
 *
 * This function detects that condition and trims our store to match reality.
 */
export async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0) {
        return;
    }
    if (store.summarizedUpTo < 0) {
        return;
    }

    const chatLength = chat.length;

    // If summarizedUpTo is beyond (or at) the end of the chat, we branched
    if (store.summarizedUpTo >= chatLength) {
        const oldSummarizedUpTo = store.summarizedUpTo;
        log(
            `Branch detected! summarizedUpTo (${oldSummarizedUpTo}) >= chat length (${chatLength}). Repairing...`,
        );

        // Remove Layer 0 snippets whose turnRange extends beyond the branch point
        if (store.layers[0]) {
            const before = store.layers[0].length;
            store.layers[0] = store.layers[0].filter((sn) => {
                if (!sn.turnRange) {
                    return true;
                } // promoted snippets without turnRange are kept
                return sn.turnRange[1] < chatLength;
            });
            const removed = before - store.layers[0].length;
            if (removed > 0) {
                log(
                    `Removed ${removed} Layer 0 snippets that referenced turns beyond branch point`,
                );
            }
        }

        // Recalculate summarizedUpTo based on remaining snippets
        if (store.layers[0] && store.layers[0].length > 0) {
            const maxEnd = Math.max(
                ...store.layers[0]
                    .filter((sn) => sn.turnRange)
                    .map((sn) => /** @type {Array<number>} */ (sn.turnRange)[1]),
            );
            store.summarizedUpTo = maxEnd;
        } else {
            store.summarizedUpTo = -1;
        }

        // Trim ghostedIndices to only include valid indices
        if (store.ghostedIndices) {
            store.ghostedIndices = store.ghostedIndices.filter((idx) => idx < chatLength);
        }

        await saveChatStore();

        log(
            `Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}`,
        );

        toastr.info(
            `Branch detected — trimmed ${oldSummarizedUpTo - store.summarizedUpTo} turns of stale summary data that referenced messages beyond the branch point.`,
            'Summaryception — Branch Repair',
            { timeOut: 6000 },
        );
    }
}
