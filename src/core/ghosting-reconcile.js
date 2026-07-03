import { log } from '../foundation/logger.js';
import {
    calculateContiguousSummarizedUpTo,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { ghostMessagesUpTo } from './ghosting.js';

/**
 * Repair missing Summaryception ghost flags after loading existing metadata.
 * @returns {Promise<boolean>} True when repair work was started
 */
export async function repairMissingGhostingForSummaries() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    if (store.summarizedUpTo < 0 || !hasSummaries(store)) {
        return false;
    }
    if (!hasMissingGhostFlags(chat, store.summarizedUpTo)) {
        return false;
    }

    await ghostMessagesUpTo(store.summarizedUpTo);
    return true;
}

/**
 * Detect and trim Summaryception metadata copied from a longer branched chat.
 * @returns {Promise<void>}
 */
export async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0 || store.summarizedUpTo < 0) {
        return;
    }

    const chatLength = chat.length;
    if (store.summarizedUpTo < chatLength) {
        return;
    }

    const oldSummarizedUpTo = store.summarizedUpTo;
    log(
        `Branch detected! summarizedUpTo (${oldSummarizedUpTo}) >= chat length (${chatLength}). Repairing...`,
    );

    trimLayer0PastBranch(store, chatLength);
    store.summarizedUpTo = calculateContiguousSummarizedUpTo(store);
    store.ghostedIndices = store.ghostedIndices.filter((idx) => idx < chatLength);

    await saveChatStore();

    log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} -> ${store.summarizedUpTo}`);
    toastr.info(
        `Branch detected - trimmed ${oldSummarizedUpTo - store.summarizedUpTo} turns of stale summary data that referenced messages beyond the branch point.`,
        'Summaryception - Branch Repair',
        { timeOut: 6000 },
    );
}

/**
 * Remove Layer 0 snippets that point beyond the current chat length.
 * @param {object} store
 * @param {number} chatLength
 * @returns {void}
 */
function trimLayer0PastBranch(store, chatLength) {
    if (!store.layers[0]) {
        return;
    }

    const before = store.layers[0].length;
    store.layers[0] = store.layers[0].filter((snippet) => {
        if (!snippet.turnRange) {
            return true;
        }
        return snippet.turnRange[1] < chatLength;
    });

    const removed = before - store.layers[0].length;
    if (removed > 0) {
        log(`Removed ${removed} Layer 0 snippets that referenced turns beyond branch point`);
    }
}

/**
 * Check whether the store contains any summary snippets.
 * @param {object} store
 * @returns {boolean}
 */
function hasSummaries(store) {
    return store.layers.some((layer) => layer.length > 0);
}

/**
 * Check whether summarized messages are missing Summaryception ghost flags.
 * @param {Array} chat
 * @param {number} endIndex
 * @returns {boolean}
 */
function hasMissingGhostFlags(chat, endIndex) {
    const last = Math.min(endIndex, chat.length - 1);
    for (let i = 0; i <= last; i++) {
        const msg = chat[i];
        if (shouldRepairLoadedGhostFlag(msg)) {
            return true;
        }
    }
    return false;
}

/**
 * Check whether one loaded message should be repaired.
 * @param {object} msg
 * @returns {boolean}
 */
function shouldRepairLoadedGhostFlag(msg) {
    if (!msg || msg.extra?.sc_ghosted) {
        return false;
    }
    if (msg.is_system || msg.is_hidden || !msg.mes?.trim()) {
        return false;
    }
    return true;
}
