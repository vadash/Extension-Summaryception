import { LOG_PREFIX } from '../foundation/constants.js';
import { executeSlashCommandsWithOptions, getChat } from '../foundation/context.js';
import { getChatStore } from '../foundation/state.js';
import { log } from '../foundation/logger.js';
import { persistChatState } from './persist-state.js';
import { canStartPromptMutation, queuePromptEffect, runPromptEffect } from './summarizer-commit.js';

// Message hiding (ghosting via native /hide and /unhide)

/**
 * @typedef {object} GhostRangeOptions
 * @property {boolean} [showProgress] - Show a progress toast for manual work.
 * @property {string} [kind] - Prompt-effect queue label.
 * @property {'immediate' | 'deferred'} [chatSave] - Chat-file persistence mode.
 */

/**
 * Ensure all Summaryception-eligible messages in a range are ghosted.
 * @param {number} startIdx - Start index in chat
 * @param {number} endIdx - End index in chat
 * @param {GhostRangeOptions} [options]
 * @returns {Promise<void>}
 */
export async function repairGhostingForRange(startIdx, endIdx, options = {}) {
    await ghostMessagesInRange(startIdx, endIdx, { kind: 'ghost-repair', ...options });
}

/**
 * Ghost a single message by index.
 * @param {number} messageIndex - The chat index to ghost
 * @returns {Promise<void>}
 */
export async function ghostMessage(messageIndex) {
    await ghostMessagesInRange(messageIndex, messageIndex, { kind: 'ghost-message' });
}

/**
 * Ghost all eligible messages from index 0 up to and including endIndex.
 * @param {number} endIndex - The highest index to ghost
 * @param {GhostRangeOptions} [options]
 * @returns {Promise<void>}
 */
export async function ghostMessagesUpTo(endIndex, options = {}) {
    await ghostMessagesInRange(0, endIndex, { kind: 'ghost-up-to', ...options });
}

/**
 * Ghost eligible messages in a specific chat range.
 * @internal
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {GhostRangeOptions} [options]
 * @returns {Promise<void>}
 */
export async function ghostMessagesInRange(startIdx, endIdx, options = {}) {
    await runPromptEffect({
        kind: getGhostEffectKind(startIdx, endIdx, options),
        apply: async ({ epoch }) =>
            await ghostMessagesInRangeEffect(startIdx, endIdx, epoch, options),
    });
}

/**
 * Unghost all messages that Summaryception ghosted.
 * @returns {Promise<void>}
 */
export async function unghostAllMessages() {
    const chat = getChat();
    const store = getChatStore();
    const ranges = getOwnedGhostRanges(chat, store);
    const total = countRangeMessages(ranges);

    if (total === 0) {
        return;
    }

    const progressToast = createUnhideProgressToast(total);
    await unhideRanges({ chat, store, ranges, progressToast, total });
    toastr.clear(progressToast);
    log(`Unghosted ${total} messages (only Summaryception-hidden ones)`);
}

/**
 * Unghost Summaryception-owned messages in a specific chat range.
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {Promise<void>}
 */
export async function unghostMessagesInRange(startIdx, endIdx) {
    const chat = getChat();
    const store = getChatStore();
    const range = normalizeRange(startIdx, endIdx, chat.length);

    if (!range) {
        return;
    }

    const ranges = getOwnedGhostRanges(chat, store, range);
    await unhideRanges({ chat, store, ranges });
}

/**
 * Apply deferred range ghosting while the prompt guard remains open.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {number} epoch
 * @param {GhostRangeOptions} options
 * @returns {Promise<boolean>}
 */
async function ghostMessagesInRangeEffect(startIdx, endIdx, epoch, options) {
    const chat = getChat();
    const range = normalizeRange(startIdx, endIdx, chat.length);

    if (!range) {
        return true;
    }

    const store = getChatStore();
    const ranges = collectHideRanges(chat, range);
    const total = countRangeMessages(ranges);
    const progressToast = createHideProgressToast(options, total);
    let processed = 0;

    for (const hideRange of ranges) {
        if (!canStartPromptMutation(epoch)) {
            return queueRemainingGhosting(hideRange[0], range[1], options, progressToast);
        }

        const applied = await applyHideRange({
            chat,
            store,
            range: hideRange,
            epoch,
            chatSave: options.chatSave || 'immediate',
        });

        if (!applied) {
            return queueRemainingGhosting(hideRange[0], range[1], options, progressToast);
        }

        processed += getRangeSize(hideRange);
        updateHideProgress(progressToast, processed, total);
    }

    clearProgress(progressToast);
    return true;
}

/**
 * Mark a hide range as Summaryception-owned, persist it, then visually hide it.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {[number, number]} p.range
 * @param {number} p.epoch
 * @param {'immediate' | 'deferred'} p.chatSave
 * @returns {Promise<boolean>}
 */
async function applyHideRange({ chat, store, range, epoch, chatSave }) {
    markGhostedRange(chat, store, range);
    await persistChatState({ chatSave });

    if (!canStartPromptMutation(epoch)) {
        return false;
    }

    try {
        await executeSlashCommandsWithOptions(`/hide ${formatSlashRange(range)}`, {
            showOutput: false,
        });
    } catch (e) {
        console.error(LOG_PREFIX, `Failed to hide messages ${formatSlashRange(range)}:`, e);
    }

    await persistChatState({ chatSave });
    return true;
}

/**
 * Queue the remaining ghosting work after a prompt mutation freeze.
 * @param {number} nextStart
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @param {unknown} progressToast
 * @returns {boolean}
 */
function queueRemainingGhosting(nextStart, endIdx, options, progressToast) {
    clearProgress(progressToast);
    queueGhostRange(nextStart, endIdx, options);
    return false;
}

/**
 * Queue remaining range ghosting work.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @returns {void}
 */
function queueGhostRange(startIdx, endIdx, options) {
    log(`Ghosting ${startIdx}-${endIdx} deferred; foreground generation is active.`);
    queuePromptEffect({
        kind: getGhostEffectKind(startIdx, endIdx, options),
        apply: async ({ epoch }) =>
            await ghostMessagesInRangeEffect(startIdx, endIdx, epoch, options),
    });
}

/**
 * Build contiguous ranges of messages that still need ownership or visual hide work.
 * @param {ChatMessage[]} chat
 * @param {[number, number]} range
 * @returns {Array<[number, number]>}
 */
function collectHideRanges(chat, range) {
    const indices = [];
    for (let i = range[0]; i <= range[1]; i++) {
        if (messageNeedsGhosting(chat[i])) {
            indices.push(i);
        }
    }
    return rangesFromSortedIndices(indices);
}

/**
 * Check whether a message needs Summaryception ownership or visual hiding.
 * @param {ChatMessage | undefined} msg
 * @returns {boolean}
 */
function messageNeedsGhosting(msg) {
    if (!msg || !isGhostableMessage(msg)) {
        return false;
    }

    const owned = msg.extra?.sc_ghosted === true;
    return !owned || !isVisuallyHidden(msg);
}

/**
 * Check whether a message is eligible for Summaryception ghosting.
 * @param {ChatMessage | undefined} msg
 * @returns {boolean}
 */
function isGhostableMessage(msg) {
    if (!msg || !msg.mes?.trim()) {
        return false;
    }
    return !isUserHidden(msg);
}

/**
 * Check whether a message is hidden by the user or by non-Summaryception system state.
 * @param {ChatMessage} msg
 * @returns {boolean}
 */
function isUserHidden(msg) {
    return isVisuallyHidden(msg) && msg.extra?.sc_ghosted !== true;
}

/**
 * Check whether SillyTavern is visually hiding a message.
 * @param {ChatMessage} msg
 * @returns {boolean}
 */
function isVisuallyHidden(msg) {
    return msg?.is_hidden === true || msg?.is_system === true;
}

/**
 * Record a range as ghosted in memory.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {void}
 */
function markGhostedRange(chat, store, range) {
    for (let i = range[0]; i <= range[1]; i++) {
        const msg = chat[i];
        if (!msg) {
            continue;
        }
        msg.extra = msg.extra || {};
        msg.extra.sc_ghosted = true;
        addGhostedIndex(store, i);
    }
    store.ghostedIndices.sort((a, b) => a - b);
}

/**
 * Track a ghosted index if it is not already present.
 * @param {SummaryceptionStore} store
 * @param {number} index
 * @returns {void}
 */
function addGhostedIndex(store, index) {
    if (!store.ghostedIndices.includes(index)) {
        store.ghostedIndices.push(index);
    }
}

/**
 * Collect ranges of Summaryception-owned messages.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} [limit]
 * @returns {Array<[number, number]>}
 */
function getOwnedGhostRanges(chat, store, limit) {
    const indices = collectGhostedIndices(chat, store).filter((idx) => {
        if (!limit) {
            return true;
        }
        return idx >= limit[0] && idx <= limit[1];
    });
    return rangesFromSortedIndices(indices);
}

/**
 * Collect indices that metadata or chat flags mark as Summaryception-owned.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {number[]}
 */
function collectGhostedIndices(chat, store) {
    const result = new Set();
    for (const idx of store.ghostedIndices || []) {
        if (idx >= 0 && idx < chat.length) {
            result.add(idx);
        }
    }
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted) {
            result.add(i);
        }
    }
    return [...result].sort((a, b) => a - b);
}

/**
 * Apply batched unhide commands, then clear Summaryception ownership flags.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {Array<[number, number]>} p.ranges
 * @param {unknown} [p.progressToast]
 * @param {number} [p.total]
 * @returns {Promise<void>}
 */
async function unhideRanges({ chat, store, ranges, progressToast = null, total = 0 }) {
    let processed = 0;
    for (const range of ranges) {
        try {
            await executeSlashCommandsWithOptions(`/unhide ${formatSlashRange(range)}`, {
                showOutput: false,
            });
        } catch (e) {
            log(`Failed to unhide messages ${formatSlashRange(range)}:`, e);
        }
        clearGhostedRange(chat, store, range);
        processed += getRangeSize(range);
        updateUnhideProgress(progressToast, processed, total);
        await persistChatState();
    }
}

/**
 * Clear Summaryception ownership in a range.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {void}
 */
function clearGhostedRange(chat, store, range) {
    for (let i = range[0]; i <= range[1]; i++) {
        const msg = chat[i];
        if (msg?.extra?.sc_ghosted) {
            delete msg.extra.sc_ghosted;
        }
    }
    store.ghostedIndices = store.ghostedIndices.filter((idx) => idx < range[0] || idx > range[1]);
}

/**
 * Convert sorted indices into contiguous ranges.
 * @param {number[]} indices
 * @returns {Array<[number, number]>}
 */
function rangesFromSortedIndices(indices) {
    /** @type {Array<[number, number]>} */
    const ranges = [];
    for (const index of indices) {
        const last = ranges[ranges.length - 1];
        if (last && index === last[1] + 1) {
            last[1] = index;
        } else {
            ranges.push([index, index]);
        }
    }
    return ranges;
}

/**
 * Clamp and validate a chat index range.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {number} chatLength
 * @returns {[number, number] | null}
 */
function normalizeRange(startIdx, endIdx, chatLength) {
    if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || chatLength <= 0) {
        return null;
    }

    const start = Math.max(0, startIdx);
    const end = Math.min(endIdx, chatLength - 1);
    return start <= end ? /** @type {[number, number]} */ ([start, end]) : null;
}

/**
 * Format a slash-command range.
 * @param {[number, number]} range
 * @returns {string}
 */
function formatSlashRange(range) {
    return range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`;
}

/**
 * Count messages covered by a set of ranges.
 * @param {Array<[number, number]>} ranges
 * @returns {number}
 */
function countRangeMessages(ranges) {
    return ranges.reduce((total, range) => total + getRangeSize(range), 0);
}

/**
 * Get the number of indices in a closed range.
 * @param {[number, number]} range
 * @returns {number}
 */
function getRangeSize(range) {
    return range[1] - range[0] + 1;
}

/**
 * Build a prompt-effect queue label.
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {GhostRangeOptions} options
 * @returns {string}
 */
function getGhostEffectKind(startIdx, endIdx, options) {
    return `${options.kind || 'ghost-range'}-${startIdx}-${endIdx}`;
}

/**
 * Create a progress toast for manual hide work.
 * @param {GhostRangeOptions} options
 * @param {number} total
 * @returns {unknown}
 */
function createHideProgressToast(options, total) {
    if (!options.showProgress || total === 0) {
        return null;
    }
    return toastr.info(`Hiding messages: 0 / ${total}`, 'Summaryception - Ghosting', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });
}

/**
 * Create a progress toast for clearing Summaryception ghosting.
 * @param {number} total
 * @returns {unknown}
 */
function createUnhideProgressToast(total) {
    return toastr.info(`Unhiding messages: 0 / ${total}`, 'Summaryception - Clearing', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });
}

/**
 * Update the hide progress toast.
 * @param {unknown} progressToast
 * @param {number} processed
 * @param {number} total
 * @returns {void}
 */
function updateHideProgress(progressToast, processed, total) {
    if (!progressToast) {
        return;
    }
    updateProgressText(progressToast, 'Hiding messages', processed, total);
}

/**
 * Update the unhide progress toast at regular intervals.
 * @param {unknown} progressToast
 * @param {number} processed
 * @param {number} total
 * @returns {void}
 */
function updateUnhideProgress(progressToast, processed, total) {
    if (!progressToast || processed % 10 !== 0) {
        return;
    }
    updateProgressText(progressToast, 'Unhiding messages', processed, total);
}

/**
 * Update a toast progress message.
 * @param {unknown} progressToast
 * @param {string} label
 * @param {number} processed
 * @param {number} total
 * @returns {void}
 */
function updateProgressText(progressToast, label, processed, total) {
    const pct = Math.round((processed / total) * 100);
    $(progressToast).find('.toast-message').text(`${label}: ${processed} / ${total} (${pct}%)`);
}

/**
 * Clear an active progress toast.
 * @param {unknown} progressToast
 * @returns {void}
 */
function clearProgress(progressToast) {
    if (progressToast) {
        toastr.clear(progressToast);
    }
}
