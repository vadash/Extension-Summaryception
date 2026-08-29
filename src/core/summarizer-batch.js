import { TOAST_TITLE } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { ensureChatScIds, resolveScIdsToIndices } from '../foundation/message-identity.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    getCurrentSummarizedBoundary,
    saveChatStore,
} from '../foundation/state.js';
import { debug, error, info, isTraceEnabled, trace } from '../foundation/logger.js';
import { ghostMessagesInRange, repairGhostingForRange } from './ghosting.js';
import {
    buildMemoryInjection,
    buildPassageFromRangeWithStats,
    buildFullContext,
} from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { buildSnippetMetadataFromState } from './snippet-metadata.js';
import { commitWhenSafe, updateCommittedInjection } from './summarizer-commit.js';
import { executeLayer0StoreTransaction } from './layer0-store-transaction.js';
import { isSummarizerOutputSafe } from './prompts.js';
import { parseSnippet } from './summarizer-state.js';
import { getCurrentStateSnapshotText } from './memory-injection.js';
import { countTextTokens, formatTokenCount, formatTokenValue } from './token-count.js';
import {
    fingerprintSourceRange,
    getChatIdentity,
    getSummaryStoreSnapshotEpoch,
    isSnapshotStoreCurrent,
} from './summarizer-snapshot.js';

/**
 * Shared batch summarization logic used by normal and catch-up paths.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {{ showToasts?: boolean, catchExceptions?: boolean, sourceEndIdx?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function summarizeBatchFromTurns(
    /** @type {import('./chatutils.js').AssistantTurn[]} */ visibleTurns,
    /** @type {{ showToasts?: boolean, catchExceptions?: boolean, sourceEndIdx?: number }} */
    { showToasts = false, catchExceptions = false, sourceEndIdx } = {},
) {
    trace('>>> ENTERING summarizeBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const chat = getChat();
    if (ensureChatScIds(chat)) {
        await persistChatState({ chatSave: 'deferred' });
    }
    const store = getChatStore();
    const summarizedBoundary = getCurrentSummarizedBoundary(chat, store);

    const eligibleTurns = visibleTurns.filter((turn) => turn.index > summarizedBoundary);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        await repairGhosting(visibleTurns, summarizedBoundary);
        return false;
    }

    return await summarizeBatchCore({
        chat,
        store,
        eligibleTurns,
        opts: { showToasts, catchExceptions, sourceEndIdx },
    });
}

/**
 * Summarize cache-friendly partitions as one all-or-nothing Layer 0 transaction.
 * @param {import('./partition-planner.js').SourcePartition[]} partitions
 * @param {{ showToasts?: boolean, catchExceptions?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function summarizeAtomicLayer0Partitions(
    partitions,
    { showToasts = false, catchExceptions = false } = {},
) {
    try {
        return await summarizeAtomicLayer0PartitionsCore(partitions, { showToasts });
    } catch (err) {
        if (!catchExceptions) {
            throw err;
        }
        error('summarizeAtomicLayer0Partitions exception:', err);
        return false;
    }
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
 * @param {number} boundaryIndex
 * @returns {Promise<void>}
 */
async function repairGhosting(visibleTurns, boundaryIndex) {
    info('All visible turns are already summarized; repairing ghosting...');
    const turnsToGhost = visibleTurns.filter((t) => t.index <= boundaryIndex);
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
 * @param {{ showToasts: boolean, catchExceptions: boolean, sourceEndIdx?: number }} p.opts - Options
 * @returns {Promise<boolean>}
 */
async function summarizeBatchCore({ chat, store, eligibleTurns, opts }) {
    const batch = eligibleTurns;
    if (batch.length === 0) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const { startIdx, endIdx: batchEndIdx } = getBatchRange(batch);
    const endIdx = getSourceEndIdx(batchEndIdx, opts.sourceEndIdx);
    const summarizedBoundary = getCurrentSummarizedBoundary(chat, store);
    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  resolved summarized boundary:', summarizedBoundary);

    info(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

    ensureLayer0(store);
    const passageStart = summarizedBoundary < 0 ? 0 : summarizedBoundary + 1;
    if (!isPassageRangeValid(passageStart, endIdx)) {
        return false;
    }

    return await summarizeBatchSafely({ batch, chat, store, passageStart, endIdx, opts });
}

async function summarizeAtomicLayer0PartitionsCore(partitions, { showToasts }) {
    const usablePartitions = (partitions || []).filter((partition) => partition?.turns?.length > 0);
    if (usablePartitions.length === 0) {
        return false;
    }

    const chat = getChat();
    const store = getChatStore();
    ensureLayer0(store);
    /** @type {(success: boolean) => void} */
    let completeToast = () => {};
    let contextText = buildFullContext(0);
    const snapshots = [];
    const pendingSnippets = [];
    const baseMutationEpoch = getSummaryStoreSnapshotEpoch(store);

    for (const partition of usablePartitions) {
        if (getSummaryStoreSnapshotEpoch(store) !== baseMutationEpoch) {
            completeToast(false);
            return false;
        }

        const snapshot = await captureLayer0Snapshot({
            chat,
            store,
            passageStart: partition.sourceStartIdx,
            endIdx: partition.sourceEndIdx,
            contextText,
        });
        tracePassageTokens(snapshot);
        if (!snapshot.passageText.trim()) {
            completeToast(false);
            return false;
        }

        if (snapshots.length === 0) {
            completeToast = createSummarizationToast(showToasts);
        }
        let summary;
        try {
            summary = await callSummarizer(snapshot.passageText, snapshot.contextText, {
                kind: 'layer0',
                sourceRange: snapshot.sourceRange,
                assistantTurnCount: partition.turns.length,
                regexStats: snapshot.passageStats,
                sourceState: snapshot.sourceState,
            });
        } catch (err) {
            completeToast(false);
            throw err;
        }
        if (!summary || !isLayer0SummarySafe(summary, snapshot)) {
            completeToast(false);
            return false;
        }

        snapshots.push(snapshot);
        pendingSnippets.push(buildLayer0Snippet(snapshot, summary));
        contextText = buildPendingLayer0Context(store.layers, pendingSnippets);
    }

    let result;
    try {
        result = await commitWhenSafe({
            kind: 'layer0-atomic-cache',
            snapshot: snapshots[0],
            apply: async () => {
                const committed = await commitAtomicLayer0Snippets({ snapshots, pendingSnippets });
                completeToast(committed);
                return committed;
            },
        });
    } catch (err) {
        completeToast(false);
        throw err;
    }
    return result !== 'stale';
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
        error('summarizeBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeBatchFromTurns - EXCEPTION');
        return false;
    }
}

/**
 * Build the passage, call the summarizer, and commit the result.
 * @param {object} p - Batch parameters
 * @returns {Promise<boolean>}
 */
async function performBatchSummary({ chat, store, passageStart, endIdx, opts }) {
    const snapshot = await captureLayer0Snapshot({ chat, store, passageStart, endIdx });
    tracePassageTokens(snapshot);
    if (!snapshot.passageText.trim()) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY PASSAGE');
        return false;
    }

    await traceTextTokens('  contextStr tokens:', snapshot.contextText);

    const completeToast = createSummarizationToast(opts.showToasts);

    trace('  About to call callSummarizer...');
    let summary;
    try {
        summary = await callSummarizer(snapshot.passageText, snapshot.contextText, {
            kind: 'layer0',
            sourceRange: snapshot.sourceRange,
            regexStats: snapshot.passageStats,
            sourceState: snapshot.sourceState,
        });
    } catch (err) {
        completeToast(false);
        throw err;
    }
    await traceTextTokens('  summary tokens:', summary || '');

    if (!summary) {
        debug('Summarization failed for batch, leaving turns intact for next attempt.');
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY SUMMARY');
        completeToast(false);
        return false;
    }
    let result;
    try {
        result = await commitWhenSafe({
            kind: 'layer0',
            snapshot,
            apply: async () => {
                const committed = await commitLayer0Snippet({ snapshot, summary });
                completeToast(committed);
                return committed;
            },
        });
    } catch (err) {
        completeToast(false);
        throw err;
    }
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
 * @param {string} [p.contextText]
 * @returns {Promise<import('./summarizer-commit.js').SummarizationJobSnapshot>}
 */
async function captureLayer0Snapshot({ chat, store, passageStart, endIdx, contextText }) {
    const ctx = getContext();
    const sourceMessageIds = chat.slice(passageStart, endIdx + 1).map((message) => message?.sc_id);
    const stableSourceMessageIds = /** @type {string[]} */ (sourceMessageIds);
    if (
        sourceMessageIds.length !== endIdx - passageStart + 1 ||
        sourceMessageIds.some((id) => typeof id !== 'string' || id.trim() === '')
    ) {
        throw new Error('Cannot summarize messages without stable Summaryception IDs.');
    }
    const passage = await buildPassageFromRangeWithStats(chat, passageStart, endIdx);
    const resolvedContextText = contextText ?? buildFullContext(0);

    return {
        chatId: getChatIdentity(ctx),
        chatRef: chat,
        sourceRange: [passageStart, endIdx],
        sourceMessageIds: stableSourceMessageIds,
        sourceFingerprint: fingerprintSourceRange(chat, passageStart, endIdx),
        summaryStoreEpoch: getSummaryStoreSnapshotEpoch(store),
        passageText: passage.text,
        passageStats: passage.stats,
        contextText: resolvedContextText,
        sourceState: getCurrentStateSnapshotText(store.layers),
    };
}

/**
 * Record a successful summary into Layer 0 and trigger downstream bookkeeping.
 * @param {object} p
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot
 * @param {string} p.summary - The LLM-generated summary text
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippet({ snapshot, summary }) {
    if (!isLayer0SnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    ensureLayer0(store);

    if (!isLayer0SummarySafe(summary, snapshot)) {
        return false;
    }

    await executeLayer0Commit({
        store,
        sourceMessageIds: snapshot.sourceMessageIds,
        rollbackMessage: 'Layer 0 commit persistence failed, rolling back store state:',
        onRollback: () => {
            debug('Layer 0 commit rolled back: post-save persistence failed.');
        },
        mutate: () => {
            store.layers[0].push(buildLayer0Snippet(snapshot, summary));
            bumpSummaryStoreMutationEpoch(store);
            trace('  Added Layer 0 snippet for current source IDs.');
        },
    });

    return true;
}

async function commitAtomicLayer0Snippets({ snapshots, pendingSnippets }) {
    if (snapshots.length === 0 || pendingSnippets.length !== snapshots.length) {
        return false;
    }
    if (!snapshots.every(isLayer0SnapshotValid)) {
        return false;
    }

    const store = getChatStore();
    ensureLayer0(store);
    const sourceMessageIds = snapshots.flatMap((snapshot) => snapshot.sourceMessageIds);

    await executeLayer0Commit({
        store,
        sourceMessageIds,
        rollbackMessage: 'Layer 0 commit persistence failed, rolling back store state:',
        onRollback: () => {
            debug('Atomic Layer 0 commit rolled back: post-save persistence failed.');
        },
        mutate: () => {
            for (const snippet of pendingSnippets) {
                store.layers[0].push(snippet);
            }
            bumpSummaryStoreMutationEpoch(store);
        },
    });

    return true;
}

async function executeLayer0Commit({
    store,
    sourceMessageIds,
    mutate,
    rollbackMessage,
    onRollback,
}) {
    const chat = getChat();
    const chatRollbackPoint = [...chat];
    await executeLayer0StoreTransaction({
        store,
        mutate,
        rollbackMessage,
        onRollback: async () => {
            chat.splice(0, chat.length, ...chatRollbackPoint);
            onRollback?.();
        },
        persist: async () => {
            await saveChatStore();
            await updateCommittedInjection({ logMemoryStatus: true });
            await ghostSourceMessageIds(sourceMessageIds);
            await persistChatState({ chatSave: 'deferred' });
        },
    });
}

async function ghostSourceMessageIds(sourceMessageIds) {
    const indices = resolveScIdsToIndices(getChat(), sourceMessageIds);
    if (indices.length === 0) {
        return;
    }
    await ghostMessagesInRange(indices[0], indices[indices.length - 1], { chatSave: 'deferred' });
}

function buildLayer0Snippet(snapshot, summary) {
    const parsed = parseSnippet(summary);
    return {
        text: summary,
        sourceMessageIds: [...snapshot.sourceMessageIds],
        ...buildSnippetMetadataFromState(parsed.state),
        timestamp: Date.now(),
    };
}

function buildPendingLayer0Context(layers, pendingSnippets) {
    const workingLayers = Array.isArray(layers)
        ? layers.map((layer) => (Array.isArray(layer) ? [...layer] : []))
        : [];
    if (!workingLayers[0]) {
        workingLayers[0] = [];
    }
    workingLayers[0].push(...pendingSnippets);
    return buildMemoryInjection(workingLayers) || '(none yet)';
}

/**
 * Validate a Layer 0 summary before mutating summary storage.
 * @param {string} summary
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot
 * @returns {boolean}
 */
function isLayer0SummarySafe(summary, snapshot) {
    return isSummarizerOutputSafe(summary, {
        kind: 'layer0',
        sourceRange: snapshot.sourceRange,
        regexStats: snapshot.passageStats,
    });
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

    if (!isSnapshotStoreCurrent(snapshot, ctx, store)) {
        return false;
    }
    return fingerprintSourceRange(ctx.chat, startIdx, endIdx) === snapshot.sourceFingerprint;
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
 * Resolve the source range endpoint for a batch.
 * @param {number} batchEndIdx - Last assistant turn in the batch
 * @param {number | undefined} sourceEndIdx - Optional forced source endpoint
 * @returns {number}
 */
function getSourceEndIdx(batchEndIdx, sourceEndIdx) {
    if (
        typeof sourceEndIdx === 'number' &&
        Number.isInteger(sourceEndIdx) &&
        sourceEndIdx >= batchEndIdx
    ) {
        return sourceEndIdx;
    }
    return batchEndIdx;
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

    error(`passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
    return false;
}

/**
 * @param {boolean} showToasts
 * @returns {(success: boolean) => void}
 */
function createSummarizationToast(showToasts) {
    if (!showToasts) {
        return () => {};
    }
    const progressToast = toastr.info('Updating conversation memory…', TOAST_TITLE, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        progressBar: true,
    });
    let completed = false;
    return (success) => {
        if (completed) {
            return;
        }
        completed = true;
        toastr.clear(progressToast);
        (success ? toastr.success : toastr.warning)(
            success ? 'Conversation memory updated.' : 'Conversation memory was not updated.',
            TOAST_TITLE,
            { timeOut: 3000 },
        );
    };
}
