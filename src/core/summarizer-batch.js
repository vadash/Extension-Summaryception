import { TOAST_TITLE } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { ensureChatScIds, resolveScIdsToIndices } from '../foundation/message-identity.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    getCurrentSummarizedBoundary,
    getSummaryStoreMutationEpoch,
    saveChatStore,
} from '../foundation/state.js';
import { debug, error, info, isTraceEnabled, serializeError, trace } from '../foundation/logger.js';
import { ghostMessagesInRange, repairGhostingForRange } from './ghosting.js';
import { buildPassageFromRangeWithStats, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { buildSnippetMetadataFromState } from './snippet-metadata.js';
import { commitWhenSafe, updateCommittedInjection } from './summarizer-commit.js';
import { executeLayer0StoreTransaction } from './layer0-store-transaction.js';
import { isSummarizerOutputSafe } from './prompts.js';
import { parseSnippet } from './summarizer-state.js';
import { buildMemoryInjection, getCurrentStateSnapshotText } from './memory-injection.js';
import { formatTokenValue } from './token-count.js';
import {
    buildSnapshotBasis,
    fingerprintSourceRange,
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
    return await summarizeSafely(catchExceptions, 'summarizeAtomicLayer0Partitions', () =>
        summarizeAtomicLayer0PartitionsCore(partitions, { showToasts }),
    );
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

    return await summarizeSafely(opts.catchExceptions, 'summarizeBatchFromTurns', () =>
        performBatchSummary({ batch, chat, store, passageStart, endIdx, opts }),
    );
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
    const baseMutationEpoch = getSummaryStoreMutationEpoch(store);
    const createToast = () => {
        if (snapshots.length === 0) {
            completeToast = createSummarizationToast(showToasts);
        }
        return completeToast;
    };

    for (const partition of usablePartitions) {
        if (getSummaryStoreMutationEpoch(store) !== baseMutationEpoch) {
            completeToast(false);
            return false;
        }

        const job = await runLayer0Summarization({
            chat,
            store,
            passageStart: partition.sourceStartIdx,
            endIdx: partition.sourceEndIdx,
            contextText,
            metadata: { assistantTurnCount: partition.turns.length },
            createToast,
        });
        if (!job) {
            completeToast(false);
            return false;
        }

        snapshots.push(job.snapshot);
        pendingSnippets.push(buildLayer0Snippet(job.snapshot, job.summary));
        contextText = buildPendingLayer0Context(store.layers, pendingSnippets);
    }

    return await commitLayer0Job({
        kind: 'layer0-atomic-cache',
        snapshot: snapshots[0],
        toast: completeToast,
        commit: () => commitAtomicLayer0Snippets({ snapshots, pendingSnippets }),
    });
}

/**
 * Rethrow unless catchExceptions is set; log and report failure otherwise.
 * @param {boolean} catchExceptions - Swallow exceptions when true
 * @param {string} source - Caller name used in log prefixes
 * @param {() => Promise<boolean>} run - Summarization step to run
 * @returns {Promise<boolean>}
 */
async function summarizeSafely(catchExceptions, source, run) {
    try {
        return await run();
    } catch (err) {
        if (!catchExceptions) {
            throw err;
        }
        trace('  CAUGHT EXCEPTION:', {
            ...serializeError(err),
            stack: err?.stack?.substring?.(0, 200),
        });
        error(`${source} exception:`, err);
        trace(`<<< EXITING ${source} - EXCEPTION`);
        return false;
    }
}

/**
 * Capture, call the summarizer, and validate one Layer 0 job.
 * The toast is created only after the passage validates so earlier failures never leak it.
 * @param {object} p
 * @param {ChatMessage[]} p.chat - Chat array
 * @param {SummaryceptionStore} p.store - Chat store
 * @param {number} p.passageStart - First passage index
 * @param {number} p.endIdx - Last passage index
 * @param {string} [p.contextText] - Prebuilt pending context for multi-partition jobs
 * @param {object} [p.metadata] - Extra callSummarizer options for this job
 * @param {() => (success: boolean) => void} p.createToast - Toast factory invoked once the passage is valid
 * @returns {Promise<{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, summary: string, completeToast: (success: boolean) => void} | null>}
 */
async function runLayer0Summarization({
    chat,
    store,
    passageStart,
    endIdx,
    contextText,
    metadata,
    createToast,
}) {
    const snapshot = await captureLayer0Snapshot({
        chat,
        store,
        passageStart,
        endIdx,
        contextText,
    });
    tracePassageTokens(snapshot);
    if (!snapshot.passageText.trim()) {
        return null;
    }

    const completeToast = createToast();

    let outcome;
    try {
        outcome = await callSummarizer(snapshot.passageText, snapshot.contextText, {
            kind: 'layer0',
            sourceRange: snapshot.sourceRange,
            regexStats: snapshot.passageStats,
            sourceState: snapshot.sourceState,
            ...metadata,
        });
    } catch (err) {
        completeToast(false);
        throw err;
    }
    const summary = outcome.status === 'completed' ? outcome.text : '';
    if (!summary || !isLayer0SummarySafe(summary, snapshot)) {
        completeToast(false);
        return null;
    }
    return { snapshot, summary, completeToast };
}

/**
 * Commit a validated Layer 0 job as soon as the prompt guard allows, reporting on the toast.
 * @param {object} p
 * @param {string} p.kind - Commit job kind
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot - Job snapshot
 * @param {(success: boolean) => void} p.toast - Toast completion callback
 * @param {() => Promise<boolean>} p.commit - Commit executed inside commitWhenSafe's apply
 * @returns {Promise<boolean>}
 */
async function commitLayer0Job({ kind, snapshot, toast, commit }) {
    let result;
    try {
        result = await commitWhenSafe({
            kind,
            snapshot,
            apply: async () => {
                const committed = await commit();
                toast(committed);
                return committed;
            },
        });
    } catch (err) {
        toast(false);
        throw err;
    }
    return result !== 'stale';
}

/**
 * Build the passage, call the summarizer, and commit the result.
 * @param {object} p - Batch parameters
 * @returns {Promise<boolean>}
 */
async function performBatchSummary({ chat, store, passageStart, endIdx, opts }) {
    const job = await runLayer0Summarization({
        chat,
        store,
        passageStart,
        endIdx,
        createToast: () => createSummarizationToast(opts.showToasts),
    });
    if (!job) {
        return false;
    }

    return await commitLayer0Job({
        kind: 'layer0',
        snapshot: job.snapshot,
        toast: job.completeToast,
        commit: () => commitLayer0Snippet({ snapshot: job.snapshot, summary: job.summary }),
    });
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
        ...buildSnapshotBasis({ chatRef: chat, store, ctx }),
        sourceRange: [passageStart, endIdx],
        sourceMessageIds: stableSourceMessageIds,
        sourceFingerprint: fingerprintSourceRange(chat, passageStart, endIdx),
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
