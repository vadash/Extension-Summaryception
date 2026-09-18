import { BATCH_PROGRESS } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { ensureChatScIds } from '../foundation/message-identity.js';
import { getChatStore, getCurrentSummarizedBoundary } from '../foundation/state.js';
import { debug, error, info, isTraceEnabled, serializeError, trace } from '../foundation/logger.js';
import { repairGhostingForRange } from './ghosting.js';
import { buildPassageFromRangeWithStats, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { buildSnippetMetadataFromText } from './snippet-metadata.js';
import { commitWhenSafe } from './summarizer-commit.js';
import { commitSnippetMutation } from './snippet-commit.js';
import { isSummarizerOutputSafe } from './summarizer-output.js';
import { buildMemoryInjection } from './memory-injection.js';
import { formatTokenValue } from './token-count.js';
import {
    buildSnapshotBasis,
    fingerprintSourceRange,
    isSnapshotStoreCurrent,
} from './summarizer-snapshot.js';

/**
 * Shared batch summarization logic used by normal and catch-up paths.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {{ catchExceptions?: boolean, sourceEndIdx?: number }} [opts]
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter threaded from the engine; runs without one stay silent.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
export async function summarizeBatchFromTurns(
    /** @type {import('./chatutils.js').AssistantTurn[]} */ visibleTurns,
    /** @type {{ catchExceptions?: boolean, sourceEndIdx?: number }} */
    { catchExceptions = false, sourceEndIdx } = {},
    /** @type {import('./notify.js').NotifyAdapter | undefined} */ notify,
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
        await repairGhosting(visibleTurns, summarizedBoundary, notify);
        return { status: 'idle' };
    }
    return await summarizeBatchCore({
        chat,
        store,
        eligibleTurns,
        opts: { catchExceptions, sourceEndIdx },
        notify,
    });
}

/**
 * Summarize cache-friendly partitions as one all-or-nothing Layer 0 transaction.
 * @param {import('./partition-planner.js').SourcePartition[]} partitions
 * @param {{ catchExceptions?: boolean }} [opts]
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter threaded from the engine; runs without one stay silent.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
export async function summarizeAtomicLayer0Partitions(
    partitions,
    { catchExceptions = false } = {},
    /** @type {import('./notify.js').NotifyAdapter | undefined} */ notify,
) {
    return await summarizeSafely(catchExceptions, 'summarizeAtomicLayer0Partitions', () =>
        summarizeAtomicLayer0PartitionsCore(partitions, notify),
    );
}

/**
 * Repair ghosting for turns already marked as summarized.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {number} boundaryIndex
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter threaded to ghosting progress events
 * @returns {Promise<void>}
 */
async function repairGhosting(visibleTurns, boundaryIndex, notify) {
    info('All visible turns are already summarized; repairing ghosting...');
    const turnsToGhost = visibleTurns.filter((t) => t.index <= boundaryIndex);
    if (turnsToGhost.length > 0) {
        const first = turnsToGhost[0].index;
        const last = turnsToGhost[turnsToGhost.length - 1].index;
        await repairGhostingForRange(first, last, { chatSave: 'deferred', notify });
    }
    await persistChatState({ chatSave: 'deferred' });
    trace('<<< EXITING summarizeBatchFromTurns - REPAIRED GHOSTING');
}

/**
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {import('./chatutils.js').AssistantTurn[]} p.eligibleTurns
 * @param {{ catchExceptions: boolean, sourceEndIdx?: number }} p.opts
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function summarizeBatchCore({ chat, store, eligibleTurns, opts, notify }) {
    const batch = eligibleTurns;
    if (batch.length === 0) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY BATCH');
        return { status: 'idle' };
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
        return { status: 'idle' };
    }

    return await summarizeSafely(opts.catchExceptions, 'summarizeBatchFromTurns', () =>
        performBatchSummary({ batch, chat, store, passageStart, endIdx, notify }),
    );
}
/**
 * One shared progress owner opens at the first
 * validated passage and settles exactly once at the terminal outcome.
 * @param {import('./partition-planner.js').SourcePartition[]} partitions
 * @param {import('./notify.js').NotifyAdapter | undefined} notify
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function summarizeAtomicLayer0PartitionsCore(partitions, notify) {
    const usablePartitions = (partitions || []).filter((partition) => partition?.turns?.length > 0);
    if (usablePartitions.length === 0) {
        return { status: 'idle' };
    }

    const chat = getChat();
    const store = getChatStore();
    ensureLayer0(store);
    const progress = createBatchProgress(notify);
    let contextText = buildFullContext(0);
    const snapshots = [];
    const pendingSnippets = [];

    try {
        for (const partition of usablePartitions) {
            // Live freshness ask before each request: catches both same-store
            // mutations (epoch drift) and chat switches (identity check). A
            // stale run aborts instead of burning doomed requests per partition;
            // dirty flags / chat reconciliation re-trigger the work.
            if (
                snapshots.length > 0 &&
                !isSnapshotStoreCurrent(snapshots[0], getContext(), store)
            ) {
                progress.settle(BATCH_PROGRESS.ABORTED);
                return { status: 'aborted', completed: snapshots.length };
            }

            const result = await runLayer0Summarization({
                chat,
                store,
                passageStart: partition.sourceStartIdx,
                endIdx: partition.sourceEndIdx,
                contextText,
                notify,
                progress,
                total: usablePartitions.length,
            });
            if (result.status) {
                progress.settle();
                return { status: 'failed', completed: snapshots.length, failed: 1 };
            }

            snapshots.push(result.snapshot);
            pendingSnippets.push(buildLayer0Snippet(result.snapshot, result.summary));
            contextText = buildPendingLayer0Context(store.layers, pendingSnippets);
            progress.update(snapshots.length);
        }

        const committed = await commitLayer0Job({
            kind: 'layer0-atomic-cache',
            snapshot: snapshots[0],
            progress,
            commit: () =>
                commitLayer0Snippets({
                    entries: snapshots.map((snapshot, index) => ({
                        snapshot,
                        snippet: pendingSnippets[index],
                    })),
                    notify,
                }),
        });
        return committed
            ? { status: 'completed', completed: snapshots.length }
            : { status: 'failed', failed: snapshots.length };
    } catch (err) {
        // Snapshot capture or partition bookkeeping can throw after the shared
        // handle opened; settle it before the exception reaches summarizeSafely.
        progress.settle();
        throw err;
    }
}

/**
 * No-ops when the adapter or the handle never opened (silent runs, failures
 * before validation).
 * @param {import('./notify.js').NotifyAdapter | undefined} notify
 * @param {unknown} progress - Progress handle, or null before the first validation
 * @param {string} kind - Terminal event kind from BATCH_PROGRESS
 * @returns {void}
 */
function closeBatchProgress(notify, progress, kind) {
    if (notify && progress) {
        notify.clear(progress, { kind });
    }
}

/**
 * Internal owner of one batch progress lifecycle (one handle per run).
 * Opens lazily on the first validated passage, updates through the run, and
 * settles exactly once with a terminal event kind. Runs without an adapter
 * never open a handle, so every settlement is a silent no-op.
 * @typedef {{ open: (total: number) => unknown, update: (processed: number) => void, settle: (kind?: string) => void }} BatchProgressOwner
 */

/**
 * @param {import('./notify.js').NotifyAdapter | undefined} notify
 * @returns {BatchProgressOwner}
 */
function createBatchProgress(notify) {
    let handle = null;
    let settled = false;
    return {
        open(total) {
            if (settled || !notify) {
                return null;
            }
            if (!handle) {
                handle = notify.progress({ label: BATCH_PROGRESS.MEMORY, total });
            }
            return handle;
        },
        update(processed) {
            if (handle && !settled) {
                notify?.update(handle, { processed });
            }
        },
        settle(kind = BATCH_PROGRESS.FAILED) {
            if (settled) {
                return;
            }
            settled = true;
            closeBatchProgress(notify, handle, kind);
        },
    };
}

/**
 * Rethrow unless catchExceptions is set; log and report failure otherwise.
 * @param {boolean} catchExceptions
 * @param {string} source - Caller name used in log prefixes
 * @param {() => Promise<import('./run-outcome.js').SummarizationRunOutcome>} run
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
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
        return { status: 'failed' };
    }
}

/**
 * The progress handle opens only after the passage validates so earlier
 * failures never leak it.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {number} p.passageStart
 * @param {number} p.endIdx
 * @param {string} [p.contextText] - Prebuilt pending context for multi-partition jobs
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @param {BatchProgressOwner} p.progress - Shared batch progress owner for this run
 * @param {number} p.total
 * @returns {Promise<{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, summary: string, status?: undefined} | {status: 'idle' | 'aborted' | 'failed'}>}
 */
async function runLayer0Summarization({
    chat,
    store,
    passageStart,
    endIdx,
    contextText,
    notify,
    progress,
    total,
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
        return { status: 'idle' };
    }

    progress.open(total);

    // Every failure routes through the owner so the run's handle settles
    // exactly once, whether this run owns it or shares it across partitions.
    let outcome;
    try {
        outcome = await callSummarizer(
            snapshot.passageText,
            snapshot.contextText,
            {
                kind: 'layer0',
                sourceRange: snapshot.sourceRange,
                regexStats: snapshot.passageStats,
            },
            notify,
        );
    } catch (err) {
        progress.settle();
        throw err;
    }
    if (outcome.status === 'aborted') {
        progress.settle(BATCH_PROGRESS.ABORTED);
        return { status: 'aborted' };
    }
    const summary = outcome.status === 'completed' ? outcome.text : '';
    if (!summary || !isLayer0SummarySafe(summary, snapshot)) {
        progress.settle();
        return { status: 'failed' };
    }
    return { snapshot, summary };
}

/**
 * Commit a validated Layer 0 job as soon as the prompt guard allows, closing
 * the batch progress with the terminal outcome exactly once.
 * @param {object} p
 * @param {string} p.kind
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot
 * @param {BatchProgressOwner} p.progress - Batch progress owner for this run
 * @param {() => Promise<boolean>} p.commit - Commit executed inside commitWhenSafe's apply
 * @returns {Promise<boolean>}
 */
async function commitLayer0Job({ kind, snapshot, progress, commit }) {
    let result;
    try {
        result = await commitWhenSafe({
            kind,
            snapshot,
            apply: async () => {
                const committed = await commit();
                progress.settle(committed ? BATCH_PROGRESS.UPDATED : BATCH_PROGRESS.FAILED);
                return committed;
            },
        });
    } catch (err) {
        progress.settle();
        throw err;
    }
    return result !== 'stale';
}

/**
 * @param {object} p
 * @param {import('./chatutils.js').AssistantTurn[]} p.batch
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {number} p.passageStart
 * @param {number} p.endIdx
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function performBatchSummary({ chat, store, passageStart, endIdx, notify }) {
    const progress = createBatchProgress(notify);
    const result = await runLayer0Summarization({
        chat,
        store,
        passageStart,
        endIdx,
        notify,
        progress,
        total: 1,
    });
    if (result.status) {
        return result.status === 'idle' ? { status: 'idle' } : { status: 'failed' };
    }
    progress.update(1);

    const committed = await commitLayer0Job({
        kind: 'layer0',
        snapshot: result.snapshot,
        progress,
        commit: () =>
            commitLayer0Snippets({
                entries: [
                    {
                        snapshot: result.snapshot,
                        snippet: buildLayer0Snippet(result.snapshot, result.summary),
                    },
                ],
                notify,
            }),
    });
    return committed ? { status: 'completed', completed: 1 } : { status: 'failed' };
}

/**
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot
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
    };
}

/**
 * Commit validated Layer 0 entries as one Snippet Commit transaction, restoring
 * the chat array when post-mutation persistence fails. Every entry is
 * re-validated here so no caller can skip the checks.
 * @param {object} p
 * @param {{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, snippet: SummaryceptionSnippet}[]} p.entries - Snapshot and prebuilt snippet pairs.
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter threaded to ghosting
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippets({ entries, notify }) {
    if (
        entries.length === 0 ||
        !entries.every(
            ({ snapshot, snippet }) =>
                isLayer0SnapshotValid(snapshot) && isLayer0SummarySafe(snippet.text, snapshot),
        )
    ) {
        return false;
    }

    const store = getChatStore();
    ensureLayer0(store);
    const chat = getChat();
    const chatRollbackPoint = [...chat];
    await commitSnippetMutation(
        store,
        () => {
            for (const { snippet } of entries) {
                store.layers[0].push(snippet);
            }
            trace('  Added Layer 0 snippets for current source IDs.');
        },
        {
            chatSave: 'deferred',
            notify,
            onRollback: () => {
                chat.splice(0, chat.length, ...chatRollbackPoint);
                debug('Layer 0 commit rolled back: post-save persistence failed.');
            },
        },
    );

    return true;
}

function buildLayer0Snippet(snapshot, summary) {
    return {
        text: summary,
        sourceMessageIds: [...snapshot.sourceMessageIds],
        ...buildSnippetMetadataFromText(summary),
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
 * @param {object} store
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
