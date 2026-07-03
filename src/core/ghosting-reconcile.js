import { log } from '../foundation/logger.js';
import {
    calculateContiguousSummarizedUpTo,
    getChatStore,
    getSettings,
    saveChatStore,
} from '../foundation/state.js';
import { repairGhostingForRange } from './ghosting.js';

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

    const ranges = getSummaryRepairRanges(store, chat);
    const missing = ranges.filter((range) => hasGhostingWork(chat, range));
    if (missing.length === 0) {
        return false;
    }

    for (const range of missing) {
        await repairGhostingForRange(range[0], range[1]);
    }
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
 * Build summarized ranges that may need ghosting repair.
 * @param {object} store
 * @param {Array} chat
 * @returns {Array<[number, number]>}
 */
function getSummaryRepairRanges(store, chat) {
    const end = Math.min(store.summarizedUpTo, chat.length - 1);
    if (end < 0) {
        return [];
    }

    const ranges = [
        ...getLayer0RepairRanges(store, end),
        ...getOwnershipRepairRanges(store, chat, end),
    ];

    return ranges.length > 0 ? mergeRanges(ranges) : [/** @type {[number, number]} */ ([0, end])];
}

/**
 * Get valid Layer 0 summary source ranges.
 * @param {object} store
 * @param {number} summarizedEnd
 * @returns {Array<[number, number]>}
 */
function getLayer0RepairRanges(store, summarizedEnd) {
    /** @type {Array<[number, number]>} */
    const ranges = [];
    for (const snippet of store.layers[0] || []) {
        const range = normalizeTurnRange(snippet.turnRange, summarizedEnd);
        if (range) {
            ranges.push(range);
        }
    }
    return ranges;
}

/**
 * Get ownership markers that may represent an interrupted hide checkpoint.
 * @param {object} store
 * @param {Array} chat
 * @param {number} summarizedEnd
 * @returns {Array<[number, number]>}
 */
function getOwnershipRepairRanges(store, chat, summarizedEnd) {
    const indices = new Set(store.ghostedIndices || []);
    for (let i = 0; i <= summarizedEnd; i++) {
        if (chat[i]?.extra?.sc_ghosted) {
            indices.add(i);
        }
    }
    return [...indices]
        .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx <= summarizedEnd)
        .map((idx) => /** @type {[number, number]} */ ([idx, idx]));
}

/**
 * Normalize a snippet turn range against the summarized cursor.
 * @param {unknown} range
 * @param {number} summarizedEnd
 * @returns {[number, number] | null}
 */
function normalizeTurnRange(range, summarizedEnd) {
    if (!Array.isArray(range) || range.length < 2) {
        return null;
    }
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
        return null;
    }

    const start = Math.max(0, range[0]);
    const end = Math.min(range[1], summarizedEnd);
    return start <= end ? /** @type {[number, number]} */ ([start, end]) : null;
}

/**
 * Merge overlapping or adjacent ranges.
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    /** @type {Array<[number, number]>} */
    const merged = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1] + 1) {
            last[1] = Math.max(last[1], range[1]);
        } else {
            merged.push(/** @type {[number, number]} */ ([...range]));
        }
    }
    return merged;
}

/**
 * Check whether a repair range contains missing ownership or visual hide work.
 * @param {Array} chat
 * @param {[number, number]} range
 * @returns {boolean}
 */
function hasGhostingWork(chat, range) {
    const disableGhosting = getSettings().disableGhosting;
    for (let i = range[0]; i <= range[1]; i++) {
        if (shouldRepairLoadedMessage(chat[i], disableGhosting)) {
            return true;
        }
    }
    return false;
}

/**
 * Check whether one loaded message should be repaired.
 * @param {object} msg
 * @param {boolean} disableGhosting
 * @returns {boolean}
 */
function shouldRepairLoadedMessage(msg, disableGhosting) {
    if (!msg || msg.is_user || !msg.mes?.trim() || isUserHidden(msg)) {
        return false;
    }

    const owned = msg.extra?.sc_ghosted === true;
    if (disableGhosting) {
        return !owned;
    }
    return !owned || !isVisuallyHidden(msg);
}

/**
 * Check whether a message is user-hidden or non-Summaryception system state.
 * @param {object} msg
 * @returns {boolean}
 */
function isUserHidden(msg) {
    return isVisuallyHidden(msg) && msg.extra?.sc_ghosted !== true;
}

/**
 * Check whether SillyTavern is visually hiding a message.
 * @param {object} msg
 * @returns {boolean}
 */
function isVisuallyHidden(msg) {
    return msg?.is_hidden === true || msg?.is_system === true;
}
