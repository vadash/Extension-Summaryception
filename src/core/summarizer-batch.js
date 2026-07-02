import { LOG_PREFIX } from '../foundation/constants.js';
import { getSettings, getChatStore, saveChatStore } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { ghostMessage, ghostMessagesUpTo } from './ghosting.js';
import { buildPassageFromRange, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { maybePromoteLayer } from './summarizer-promotion.js';

/**
 * Shared batch summarization logic used by normal and catch-up paths.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @param {{ showToasts?: boolean, catchExceptions?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function summarizeBatchFromTurns(
    /** @type {Array<Record<string, unknown>>} */ visibleTurns,
    /** @type {{ showToasts?: boolean, catchExceptions?: boolean }} */
    { showToasts = false, catchExceptions = false } = {},
) {
    trace('>>> ENTERING summarizeBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const eligibleTurns = visibleTurns.filter(
        (t) => /** @type {number} */ (t.index) > store.summarizedUpTo,
    );
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        await repairGhosting(visibleTurns, store.summarizedUpTo);
        return false;
    }

    return await summarizeBatchCore({
        s,
        chat,
        store,
        eligibleTurns,
        opts: { showToasts, catchExceptions },
    });
}

/**
 * Summarize one batch from pre-computed turns with exception catching.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatchFromTurns(visibleTurns) {
    return await summarizeBatchFromTurns(visibleTurns, { catchExceptions: true });
}

/**
 * Repair ghosting for turns already marked as summarized.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @param {number} summarizedUpTo
 * @returns {Promise<void>}
 */
async function repairGhosting(visibleTurns, summarizedUpTo) {
    log('All visible turns are already summarized — repairing ghosting...');
    const turnsToGhost = visibleTurns.filter(
        (t) => /** @type {number} */ (t.index) <= summarizedUpTo,
    );
    for (const t of turnsToGhost) {
        await ghostMessage(/** @type {number} */ (t.index));
    }
    await persistChatState();
    trace('<<< EXITING summarizeBatchFromTurns - REPAIRED GHOSTING');
}

/**
 * Core logic for summarizing a batch of turns.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {Array} p.chat - Chat array
 * @param {object} p.store - Chat store
 * @param {Array<Record<string, unknown>>} p.eligibleTurns - Eligible turns
 * @param {{ showToasts: boolean, catchExceptions: boolean }} p.opts - Options
 * @returns {Promise<boolean>}
 */
async function summarizeBatchCore({ s, chat, store, eligibleTurns, opts }) {
    const batch = eligibleTurns.slice(0, Math.min(s.turnsPerSummary, eligibleTurns.length));

    if (batch.length === 0) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const { startIdx, endIdx } = getBatchRange(batch);
    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

    ensureLayer0(store);
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    if (!isPassageRangeValid(passageStart, endIdx)) {
        return false;
    }

    return await summarizeBatchSafely({
        batch,
        chat,
        store,
        passageStart,
        endIdx,
        opts,
    });
}

/**
 * Summarize a batch and optionally swallow exceptions for catch-up mode.
 * @param {object} p - Batch parameters
 * @returns {Promise<boolean>}
 */
async function summarizeBatchSafely(p) {
    try {
        return await performBatchSummary(p);
    } catch (err) {
        if (!p.opts.catchExceptions) {
            throw err;
        }
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeBatchFromTurns - EXCEPTION');
        return false;
    }
}

/**
 * Build the passage, call the summarizer, and commit the result.
 * @param {object} p - Batch parameters
 * @returns {Promise<boolean>}
 */
async function performBatchSummary({ batch, chat, store, passageStart, endIdx, opts }) {
    const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    if (!storyTxt.trim()) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY PASSAGE');
        return false;
    }

    const contextStr = buildFullContext(0);
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    showBatchToast(batch.length, opts.showToasts);

    trace('  About to call callSummarizer...');
    const summary = await callSummarizer(storyTxt, contextStr);
    trace('  summary length:', summary?.length ?? 'UNDEFINED');

    if (!summary) {
        log('Summarization failed for batch, leaving turns intact for next attempt.');
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY SUMMARY');
        return false;
    }

    await commitLayer0Snippet({
        store,
        summary,
        passageStart,
        endIdx,
        showToasts: opts.showToasts,
    });

    trace('<<< EXITING summarizeBatchFromTurns - SUCCESS');
    return true;
}

/**
 * Record a successful summary into Layer 0 and trigger downstream bookkeeping.
 * @param {object} p
 * @param {object} p.store - The chat store
 * @param {string} p.summary - The LLM-generated summary text
 * @param {number} p.passageStart - First chat index covered
 * @param {number} p.endIdx - Last chat index covered
 * @param {boolean} p.showToasts - Whether to show success toast
 * @returns {Promise<void>}
 */
async function commitLayer0Snippet({ store, summary, passageStart, endIdx, showToasts }) {
    store.layers[0].push({
        text: summary,
        turnRange: [passageStart, endIdx],
        timestamp: Date.now(),
    });

    store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
    trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

    await saveChatStore();
    await ghostMessagesUpTo(endIdx);
    await maybePromoteLayer(0);
    await persistChatState();

    log(`Layer 0 now has ${store.layers[0].length} snippets`);

    if (showToasts) {
        toastr.success(
            `Summary saved (Layer 0: ${store.layers[0].length} snippets)`,
            'Summaryception',
            { timeOut: 2000 },
        );
    }
}

/**
 * Get the first and last chat indices for a batch.
 * @param {Array<Record<string, unknown>>} batch
 * @returns {{ startIdx: number, endIdx: number }}
 */
function getBatchRange(batch) {
    return {
        startIdx: /** @type {number} */ (batch[0].index),
        endIdx: /** @type {number} */ (batch[batch.length - 1].index),
    };
}

/**
 * Ensure Layer 0 exists in the chat store.
 * @param {object} store - Chat store
 * @returns {void}
 */
function ensureLayer0(store) {
    if (!store.layers[0]) {
        store.layers[0] = [];
    }
}

/**
 * Validate the passage range before building text.
 * @param {number} passageStart - First passage index
 * @param {number} endIdx - Last passage index
 * @returns {boolean}
 */
function isPassageRangeValid(passageStart, endIdx) {
    if (passageStart <= endIdx) {
        return true;
    }

    log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
    trace('<<< EXITING summarizeBatchFromTurns - PASSAGE START GREATER THAN END');
    return false;
}

/**
 * Show a progress toast for interactive batch summarization.
 * @param {number} batchLength - Number of turns in the batch
 * @param {boolean} showToasts - Whether to show toasts
 * @returns {void}
 */
function showBatchToast(batchLength, showToasts) {
    if (!showToasts) {
        return;
    }

    toastr.info(`Summarizing ${batchLength} turn${batchLength > 1 ? 's' : ''}…`, 'Summaryception', {
        timeOut: 3000,
        progressBar: true,
    });
}
