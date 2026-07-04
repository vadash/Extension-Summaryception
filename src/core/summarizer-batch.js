import { LOG_PREFIX } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { getChatStore, saveChatStore } from '../foundation/state.js';
import { isTraceEnabled, log, trace } from '../foundation/logger.js';
import { ghostMessagesInRange, repairGhostingForRange } from './ghosting.js';
import { buildPassageFromRangeWithStats, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { commitWhenSafe, updateCommittedInjection } from './summarizer-commit.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import {
    fingerprintSourceRange,
    fingerprintSummaryStore,
    getChatIdentity,
    isSameChatSnapshot,
} from './summarizer-snapshot.js';

/**
 * Shared batch summarization logic used by normal and catch-up paths.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {{ showToasts?: boolean, catchExceptions?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function summarizeBatchFromTurns(
    /** @type {import('./chatutils.js').AssistantTurn[]} */ visibleTurns,
    /** @type {{ showToasts?: boolean, catchExceptions?: boolean }} */
    { showToasts = false, catchExceptions = false } = {},
) {
    trace('>>> ENTERING summarizeBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const chat = getChat();
    const store = getChatStore();

    const eligibleTurns = visibleTurns.filter((t) => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        await repairGhosting(visibleTurns, store.summarizedUpTo);
        return false;
    }

    return await summarizeBatchCore({
        chat,
        store,
        eligibleTurns,
        opts: { showToasts, catchExceptions },
    });
}

/**
 * Summarize one batch from pre-computed turns with exception catching.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatchFromTurns(visibleTurns) {
    return await summarizeBatchFromTurns(visibleTurns, { catchExceptions: true });
}

/**
 * Repair ghosting for turns already marked as summarized.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {number} summarizedUpTo
 * @returns {Promise<void>}
 */
async function repairGhosting(visibleTurns, summarizedUpTo) {
    log('All visible turns are already summarized — repairing ghosting...');
    const turnsToGhost = visibleTurns.filter((t) => t.index <= summarizedUpTo);
    if (turnsToGhost.length > 0) {
        const first = turnsToGhost[0].index;
        const last = turnsToGhost[turnsToGhost.length - 1].index;
        await repairGhostingForRange(first, last, { chatSave: 'deferred' });
    }
    await persistChatState({ chatSave: 'deferred' });
    trace('<<< EXITING summarizeBatchFromTurns - REPAIRED GHOSTING');
}

/**
 * Core logic for summarizing a batch of turns.
 * @param {object} p
 * @param {ChatMessage[]} p.chat - Chat array
 * @param {SummaryceptionStore} p.store - Chat store
 * @param {import('./chatutils.js').AssistantTurn[]} p.eligibleTurns - Eligible turns
 * @param {{ showToasts: boolean, catchExceptions: boolean }} p.opts - Options
 * @returns {Promise<boolean>}
 */
async function summarizeBatchCore({ chat, store, eligibleTurns, opts }) {
    const batch = eligibleTurns;
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

    return await summarizeBatchSafely({ batch, chat, store, passageStart, endIdx, opts });
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
    const snapshot = await captureLayer0Snapshot({ chat, store, passageStart, endIdx });
    tracePassageTokens(snapshot);
    if (!snapshot.passageText.trim()) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY PASSAGE');
        return false;
    }

    await traceTextTokens('  contextStr tokens:', snapshot.contextText);

    showBatchToast(batch.length, opts.showToasts);

    trace('  About to call callSummarizer...');
    const summary = await callSummarizer(snapshot.passageText, snapshot.contextText, {
        kind: 'layer0',
        sourceRange: snapshot.sourceRange,
        assistantTurnCount: batch.length,
        regexStats: snapshot.passageStats,
    });
    await traceTextTokens('  summary tokens:', summary || '');

    if (!summary) {
        log('Summarization failed for batch, leaving turns intact for next attempt.');
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY SUMMARY');
        return false;
    }

    const result = await commitWhenSafe({
        kind: 'layer0',
        snapshot,
        apply: async () =>
            await commitLayer0Snippet({
                snapshot,
                summary,
                showToasts: opts.showToasts,
            }),
    });

    trace(`<<< EXITING summarizeBatchFromTurns - ${result.toUpperCase()}`);
    return result !== 'stale';
}

/**
 * Trace token stats for the passage sent to the summarizer.
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot - Job snapshot
 * @returns {void}
 */
function tracePassageTokens(snapshot) {
    if (!isTraceEnabled()) {
        return;
    }

    const stats = snapshot.passageStats;
    trace(
        '  storyTxt tokens:',
        formatTokenValue(stats.finalTokens, stats.finalTokensEstimated),
        `after regex (was ${formatTokenValue(
            stats.rawTokens,
            stats.rawTokensEstimated,
        )} raw tokens)`,
    );
}

/**
 * Trace token count for one text value.
 * @param {string} label - Trace label
 * @param {string} text - Text to count
 * @returns {Promise<void>}
 */
async function traceTextTokens(label, text) {
    if (!isTraceEnabled()) {
        return;
    }

    const tokenCount = await countTextTokens(text || '');
    trace(label, formatTokenCount(tokenCount));
}

/**
 * Capture all state required to safely commit a layer-0 summary later.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {number} p.passageStart
 * @param {number} p.endIdx
 * @returns {Promise<import('./summarizer-commit.js').SummarizationJobSnapshot>}
 */
async function captureLayer0Snapshot({ chat, store, passageStart, endIdx }) {
    const ctx = getContext();
    const passage = await buildPassageFromRangeWithStats(chat, passageStart, endIdx);
    const contextText = buildFullContext(0);

    return {
        chatId: getChatIdentity(ctx),
        chatRef: chat,
        summarizedUpTo: store.summarizedUpTo,
        sourceRange: [passageStart, endIdx],
        sourceFingerprint: fingerprintSourceRange(chat, passageStart, endIdx),
        summaryStoreFingerprint: fingerprintSummaryStore(store),
        passageText: passage.text,
        passageStats: passage.stats,
        contextText,
    };
}

/**
 * Record a successful summary into Layer 0 and trigger downstream bookkeeping.
 * @param {object} p
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot
 * @param {string} p.summary - The LLM-generated summary text
 * @param {boolean} p.showToasts - Whether to show success toast
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippet({ snapshot, summary, showToasts }) {
    if (!isLayer0SnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    const [passageStart, endIdx] = snapshot.sourceRange;
    ensureLayer0(store);

    store.layers[0].push({
        text: summary,
        turnRange: [passageStart, endIdx],
        timestamp: Date.now(),
    });

    store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
    trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

    await saveChatStore();
    await updateCommittedInjection();
    await ghostMessagesInRange(passageStart, endIdx, { chatSave: 'deferred' });
    await persistChatState({ chatSave: 'deferred' });

    log(`Layer 0 now has ${store.layers[0].length} snippets`);

    if (showToasts) {
        toastr.success(
            `Summary saved (Layer 0: ${store.layers[0].length} snippets)`,
            'Summaryception',
            { timeOut: 2000 },
        );
    }

    return true;
}

/**
 * Revalidate the active chat and store before committing an LLM result.
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot
 * @returns {boolean}
 */
function isLayer0SnapshotValid(snapshot) {
    const ctx = getContext();
    const store = getChatStore();
    const [startIdx, endIdx] = snapshot.sourceRange;

    if (!isSameChatSnapshot(snapshot, ctx)) {
        return false;
    }
    if (store.summarizedUpTo !== snapshot.summarizedUpTo) {
        return false;
    }
    if (fingerprintSourceRange(ctx.chat, startIdx, endIdx) !== snapshot.sourceFingerprint) {
        return false;
    }
    return fingerprintSummaryStore(store) === snapshot.summaryStoreFingerprint;
}

/**
 * Get the first and last chat indices for a batch.
 * @param {import('./chatutils.js').AssistantTurn[]} batch
 * @returns {{ startIdx: number, endIdx: number }}
 */
function getBatchRange(batch) {
    return {
        startIdx: batch[0].index,
        endIdx: batch[batch.length - 1].index,
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
