import { getChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';
import {
    calculateContiguousSummarizedUpTo,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { repairGhostingForRange } from './ghosting.js';

/**
 * Repair missing Summaryception ghost flags after loading existing metadata.
 * @returns {Promise<boolean>} True when repair work was started
 */
export async function repairMissingGhostingForSummaries() {
    const chat = getChat();
    const store = getChatStore();
    if (store.summarizedUpTo < 0 || !hasSummaries(store)) {
        return false;
    }

    const range = getProcessedRepairRange(store, chat);
    if (!range || !hasGhostingWork(chat, range)) {
        return false;
    }

    log(`Repairing summarized ghosting gaps in processed range 0-${range[1]}`);
    await repairGhostingForRange(range[0], range[1]);
    return true;
}

/**
 * Detect and trim Summaryception metadata copied from a longer branched chat.
 * @returns {Promise<void>}
 */
export async function repairIfBranched() {
    const chat = getChat();
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
 * Build the processed prefix that may need ghosting repair.
 * @param {SummaryceptionStore} store
 * @param {ChatMessage[]} chat
 * @returns {[number, number] | null}
 */
function getProcessedRepairRange(store, chat) {
    const end = Math.min(store.summarizedUpTo, chat.length - 1);
    if (end < 0) {
        return null;
    }

    return [0, end];
}

/**
 * Check whether a repair range contains missing ownership or visual hide work.
 * @param {ChatMessage[]} chat
 * @param {[number, number]} range
 * @returns {boolean}
 */
function hasGhostingWork(chat, range) {
    for (let i = range[0]; i <= range[1]; i++) {
        if (shouldRepairLoadedMessage(chat[i])) {
            return true;
        }
    }
    return false;
}

/**
 * Check whether one loaded message should be repaired.
 * @param {ChatMessage | undefined} msg
 * @returns {boolean}
 */
function shouldRepairLoadedMessage(msg) {
    if (!msg || !msg.mes?.trim() || isUserHidden(msg)) {
        return false;
    }

    const owned = msg.extra?.sc_ghosted === true;
    return !owned || !isVisuallyHidden(msg);
}

/**
 * Check whether a message is user-hidden or non-Summaryception system state.
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
