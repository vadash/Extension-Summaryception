import { LOG_PREFIX } from '../foundation/constants.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { persistChatState } from './persist-state.js';
import { canStartPromptMutation, queuePromptEffect, runPromptEffect } from './summarizer-commit.js';

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
 * @returns {Promise<void>}
 */
export async function repairGhostingForRange(startIdx, endIdx) {
    await runPromptEffect({
        kind: `ghost-repair-${startIdx}-${endIdx}`,
        apply: async ({ epoch }) => await repairGhostingForRangeEffect(startIdx, endIdx, epoch),
    });
}

/**
 * Apply deferred ghost repair while the prompt guard remains open.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {number} epoch
 * @returns {Promise<boolean>}
 */
async function repairGhostingForRangeEffect(startIdx, endIdx, epoch) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        if (!canStartPromptMutation(epoch)) {
            queueGhostRepair(startIdx, endIdx, i);
            await persistChatState();
            return false;
        }

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
    await persistChatState();
    trace('<<< EXITING repairGhostingForRange');
    return true;
}

/**
 * Ghost a single message by index.
 * @param {number} messageIndex - The chat index to ghost
 * @returns {Promise<void>}
 */
export async function ghostMessage(messageIndex) {
    await runPromptEffect({
        kind: `ghost-message-${messageIndex}`,
        apply: async ({ epoch }) => await ghostMessageEffect(messageIndex, epoch),
    });
}

/**
 * Apply deferred single-message ghosting.
 * @param {number} messageIndex
 * @param {number} epoch
 * @returns {Promise<boolean>}
 */
async function ghostMessageEffect(messageIndex, epoch) {
    if (!canStartPromptMutation(epoch)) {
        queueGhostMessage(messageIndex);
        return false;
    }
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) {
        return true;
    }
    if (!msg.extra) {
        msg.extra = {};
    }
    if (msg.extra.sc_ghosted) {
        return true;
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
            if (!canStartPromptMutation(epoch)) {
                queueGhostMessage(messageIndex);
                return false;
            }
            await SillyTavern.getContext().executeSlashCommandsWithOptions(
                `/hide ${messageIndex}`,
                { showOutput: false },
            );
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
    await persistChatState();
    return true;
}

/**
 * Collect indices of messages that we ghosted.
 * @param {Array} chat - The chat array
 * @param {object} store - The chat store
 * @returns {number[]} Indices to unhide
 */
function collectGhostedIndices(chat, store) {
    const result = new Set(store.ghostedIndices || []);
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted) {
            result.add(i);
        }
    }
    return [...result].sort((a, b) => a - b);
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
    await persistChatState();
    toastr.clear(progressToast);
    log(`Unghosted ${toUnhide.length} messages (only Summaryception-hidden ones)`);
}

/**
 * Unghost Summaryception-owned messages in a specific chat range.
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {Promise<void>}
 */
export async function unghostMessagesInRange(startIdx, endIdx) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chat[i];
        if (msg?.extra?.sc_ghosted) {
            delete msg.extra.sc_ghosted;
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, {
                    showOutput: false,
                });
            } catch (e) {
                log(`Failed to unhide message ${i}:`, e);
            }
        }
    }

    store.ghostedIndices = store.ghostedIndices.filter((idx) => idx < startIdx || idx > endIdx);
    await persistChatState();
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
 * @param {number} epoch - Prompt mutation epoch captured for the effect
 * @returns {Promise<boolean>} True when the hide command was applied or not needed
 */
async function applyGhostToMessage(msg, i, epoch) {
    markGhosted(msg, i);
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            if (!canStartPromptMutation(epoch)) {
                return false;
            }
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, {
                showOutput: false,
            });
        } catch (e) {
            log(`Failed to hide message ${i}:`, e);
        }
    }
    return true;
}

/**
 * Ghost all messages from index 0 up to and including endIndex.
 * @param {number} endIndex - The highest index to ghost
 * @returns {Promise<void>}
 */
export async function ghostMessagesUpTo(endIndex) {
    await runPromptEffect({
        kind: `ghost-up-to-${endIndex}`,
        apply: async ({ epoch }) => await ghostMessagesUpToEffect(endIndex, 0, epoch),
    });
}

/**
 * Apply deferred range ghosting while the prompt guard remains open.
 * @param {number} endIndex
 * @param {number} startIndex
 * @param {number} epoch
 * @returns {Promise<boolean>}
 */
async function ghostMessagesUpToEffect(endIndex, startIndex, epoch) {
    const { chat } = SillyTavern.getContext();
    const s = getSettings();
    const progressToast = createHideProgressToast(s, endIndex);

    let processed = 0;
    for (let i = startIndex; i <= endIndex; i++) {
        if (!canStartPromptMutation(epoch)) {
            clearGhostProgress(progressToast);
            queueGhostMessagesUpTo(endIndex, i);
            return false;
        }

        const msg = chat[i];
        const ghosted = msg?.extra?.sc_ghosted === true;

        if (shouldSkipGhosting(msg, ghosted)) {
            if (msg?.is_hidden) {
                log(`Skipping message ${i} — already hidden by user`);
            }
            continue;
        }

        const applied = await applyGhostToMessage(msg, i, epoch);
        if (!applied) {
            clearGhostProgress(progressToast);
            queueGhostMessagesUpTo(endIndex, i);
            await persistChatState();
            return false;
        }
        if (!canStartPromptMutation(epoch)) {
            clearGhostProgress(progressToast);
            queueGhostMessagesUpTo(endIndex, i + 1);
            await persistChatState();
            return false;
        }

        processed++;
        if (progressToast && processed % 10 === 0) {
            updateHideProgress(progressToast, i, endIndex + 1);
        }
    }

    if (progressToast) {
        toastr.clear(progressToast);
    }
    await persistChatState();
    log(
        `Ghosted messages from index 0 to ${endIndex}${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`,
    );
    return true;
}

/**
 * Create a progress toast for hide commands when visual ghosting is enabled.
 * @param {object} s
 * @param {number} endIndex
 * @returns {unknown}
 */
function createHideProgressToast(s, endIndex) {
    if (s.disableGhosting) {
        return null;
    }
    return toastr.info(`Hiding messages: 0 / ${endIndex + 1}`, 'Summaryception — Ghosting', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });
}

/**
 * Clear an active ghosting progress toast.
 * @param {unknown} progressToast
 * @returns {void}
 */
function clearGhostProgress(progressToast) {
    if (progressToast) {
        toastr.clear(progressToast);
    }
}

/**
 * Queue a single-message ghosting effect.
 * @param {number} messageIndex
 * @returns {void}
 */
function queueGhostMessage(messageIndex) {
    log(`Ghosting deferred for message ${messageIndex}; foreground generation is active.`);
    queuePromptEffect({
        kind: `ghost-message-${messageIndex}`,
        apply: async ({ epoch }) => await ghostMessageEffect(messageIndex, epoch),
    });
}

/**
 * Queue remaining range ghosting work.
 * @param {number} endIndex
 * @param {number} startIndex
 * @returns {void}
 */
function queueGhostMessagesUpTo(endIndex, startIndex) {
    log(`Ghosting up to ${endIndex} deferred at ${startIndex}; foreground generation is active.`);
    queuePromptEffect({
        kind: `ghost-up-to-${startIndex}-${endIndex}`,
        apply: async ({ epoch }) => await ghostMessagesUpToEffect(endIndex, startIndex, epoch),
    });
}

/**
 * Queue remaining repair ghosting work.
 * @param {number} originalStart
 * @param {number} endIndex
 * @param {number} nextIndex
 * @returns {void}
 */
function queueGhostRepair(originalStart, endIndex, nextIndex) {
    log(
        `Ghost repair ${originalStart}-${endIndex} deferred at ${nextIndex}; foreground generation is active.`,
    );
    queuePromptEffect({
        kind: `ghost-repair-${nextIndex}-${endIndex}`,
        apply: async ({ epoch }) => await repairGhostingForRangeEffect(nextIndex, endIndex, epoch),
    });
}
