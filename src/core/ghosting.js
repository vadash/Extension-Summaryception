import { TOAST_TITLE } from '../foundation/constants.js';
import { executeSlashCommandsWithOptions, getChat } from '../foundation/context.js';
import {
    ensureMessageScId,
    rangesFromSortedIndices,
    resolveScIdsToIndices,
} from '../foundation/message-identity.js';
import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { debug, error, info, warn } from '../foundation/logger.js';
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

    const progressToast = createProgressToast('Unhiding messages', 'Clearing', total);
    await unhideRanges({ chat, store, ranges, progressToast, total });
    toastr.clear(progressToast);
    info(`Unghosted ${total} messages (only Summaryception-hidden ones)`);
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
    const ranges = collectHideRanges(chat, store, range);
    const total = countRangeMessages(ranges);
    const progressToast =
        options.showProgress && total > 0
            ? createProgressToast('Hiding messages', 'Ghosting', total)
            : null;
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
        updateProgress(progressToast, 'Hiding messages', { processed, total });
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

    await executeSlashRangeCommand('hide', range, error);

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
    debug(`Ghosting ${startIdx}-${endIdx} deferred; foreground generation is active.`);
    queuePromptEffect({
        kind: getGhostEffectKind(startIdx, endIdx, options),
        apply: async ({ epoch }) =>
            await ghostMessagesInRangeEffect(startIdx, endIdx, epoch, options),
    });
}

/**
 * Build contiguous ranges of messages that still need ownership or visual hide work.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} range
 * @returns {Array<[number, number]>}
 */
function collectHideRanges(chat, store, range) {
    const indices = [];
    for (let i = range[0]; i <= range[1]; i++) {
        if (messageNeedsGhosting(chat[i], store)) {
            indices.push(i);
        }
    }
    return rangesFromSortedIndices(indices);
}

/**
 * Check whether a message needs Summaryception ownership or visual hiding.
 * @param {ChatMessage | undefined} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function messageNeedsGhosting(msg, store) {
    if (!msg || !isGhostableMessage(msg, store)) {
        return false;
    }

    const owned = typeof msg.sc_id === 'string' && store.ghostedMessageIds.includes(msg.sc_id);
    return !owned || !isVisuallyHidden(msg);
}

/**
 * Check whether a message is eligible for Summaryception ghosting.
 * @param {ChatMessage | undefined} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function isGhostableMessage(msg, store) {
    if (!msg) {
        return false;
    }
    const hideNonText = getEffectiveSettings().hideNonTextMessages !== false;
    if (!hideNonText && !msg.mes?.trim()) {
        return false;
    }
    return !isUserHidden(msg, store);
}

/**
 * Check whether a message is hidden outside Summaryception ownership.
 * @param {ChatMessage} msg
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
function isUserHidden(msg, store) {
    const owned = typeof msg.sc_id === 'string' && store.ghostedMessageIds.includes(msg.sc_id);
    return isVisuallyHidden(msg) && !owned;
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
    const owned = new Set(store.ghostedMessageIds);
    for (let i = range[0]; i <= range[1]; i++) {
        const id = ensureMessageScId(chat[i]);
        if (id) {
            owned.add(id);
        }
    }
    store.ghostedMessageIds = [...owned];
}

/**
 * Collect ranges of Summaryception-owned messages.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} [limit]
 * @returns {Array<[number, number]>}
 */
function getOwnedGhostRanges(chat, store, limit) {
    return rangesFromSortedIndices(collectGhostedMessageIndices(chat, store, limit));
}

/**
 * Resolve Summaryception-owned message IDs to current chat indices.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {[number, number]} [limit]
 * @returns {number[]}
 */
export function collectGhostedMessageIndices(chat, store, limit) {
    return resolveScIdsToIndices(chat, store.ghostedMessageIds).filter(
        (index) => !limit || (index >= limit[0] && index <= limit[1]),
    );
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
        await executeSlashRangeCommand('unhide', range, warn);
        clearGhostedRange(chat, store, range);
        processed += getRangeSize(range);
        updateProgress(progressToast, 'Unhiding messages', { processed, total, everyN: 10 });
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
    const ids = new Set();
    for (let i = range[0]; i <= range[1]; i++) {
        if (typeof chat[i]?.sc_id === 'string') {
            ids.add(chat[i].sc_id);
        }
    }
    store.ghostedMessageIds = store.ghostedMessageIds.filter((id) => !ids.has(id));
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
 * Create a long-lived progress toast for ghosting work.
 * @param {string} label
 * @param {string} subtitle
 * @param {number} total
 * @returns {unknown}
 */
function createProgressToast(label, subtitle, total) {
    return toastr.info(`${label}: 0 / ${total}`, `${TOAST_TITLE} - ${subtitle}`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });
}

/**
 * Run a /hide or /unhide slash command for a range without output.
 * @param {'hide' | 'unhide'} command
 * @param {[number, number]} range
 * @param {(message: string, err: unknown) => void} logFailure
 * @returns {Promise<void>}
 */
async function executeSlashRangeCommand(command, range, logFailure) {
    try {
        await executeSlashCommandsWithOptions(`/${command} ${formatSlashRange(range)}`, {
            showOutput: false,
        });
    } catch (e) {
        logFailure(`Failed to ${command} messages ${formatSlashRange(range)}:`, e);
    }
}

/**
 * Update a progress toast, optionally throttled to every Nth processed item.
 * @param {unknown} progressToast
 * @param {string} label
 * @param {{ processed: number, total: number, everyN?: number }} p - Counts plus optional throttle step
 * @returns {void}
 */
function updateProgress(progressToast, label, { processed, total, everyN = 1 }) {
    if (!progressToast || processed % everyN !== 0) {
        return;
    }
    updateProgressText(progressToast, label, processed, total);
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
