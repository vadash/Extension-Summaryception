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
import { buildMemoryBody } from './memory-injection.js';
import { formatTokenValue } from './token-count.js';
import { SUMMARY_COMMIT_MODES } from './summarization-routes.js';
import {
    buildSnapshotBasis,
    fingerprintSourceRange,
    isSnapshotStoreCurrent,
} from './summarizer-snapshot.js';

/**
 * The Layer 0 Run: the one lifecycle that commits Layer 0 Snippets, whether the
 * route selects a single Passage or the cache-friendly route selects many
 * (CONTEXT.md, Layer 0 Run).
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter threaded from the engine; a run without one stays silent.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
export async function runLayer0(routePlan, notify) {
    const progress = createBatchProgress(notify);
    try {
        return await runPassages(routePlan, notify, progress);
    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            ...serializeError(err),
            stack: err?.stack?.substring?.(0, 200),
        });
        error('runLayer0 exception:', err);
        progress.settle();
        return { status: 'failed' };
    }
}

/**
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {import('./notify.js').NotifyAdapter | undefined} notify
 * @param {BatchProgressOwner} progress
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function runPassages(routePlan, notify, progress) {
    const chat = getChat();
    if (ensureChatScIds(chat)) {
        await persistChatState({ chatSave: 'deferred' });
    }
    const store = getChatStore();
    ensureLayer0(store);

    const boundary = getCurrentSummarizedBoundary(chat, store);
    const turns = Array.isArray(routePlan?.batchTurns) ? routePlan.batchTurns : [];
    const batch = turns.filter((turn) => turn.index > boundary);
    const passages = resolvePassages(routePlan, { boundary, batch });

    if (passages.length === 0) {
        await repairGhosting(turns, boundary, notify);
        return { status: 'idle' };
    }
    if (passages.length === 1) {
        const { startIdx, endIdx } = passages[0];
        info(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);
    }

    let contextText = buildFullContext(0);
    const snapshots = [];
    const entries = [];

    for (const passage of passages) {
        // Ask before each Passage after the first: a stale run aborts instead of
        // burning the remaining requests. The comparison reads the run's first
        // snapshot so a mutation anywhere in the run stops the rest.
        if (snapshots.length > 0 && !isSnapshotStoreCurrent(snapshots[0], getContext(), store)) {
            progress.settle(BATCH_PROGRESS.ABORTED);
            return { status: 'aborted', completed: snapshots.length };
        }

        const result = await runPassage({
            chat,
            store,
            passage,
            contextText,
            notify,
            progress,
            total: passages.length,
        });
        if (result.status !== 'completed') {
            return verdictFor(result.status, snapshots.length);
        }

        snapshots.push(result.snapshot);
        entries.push({
            snapshot: result.snapshot,
            snippet: buildLayer0Snippet(result.snapshot, result.summary),
            profile: result.profile,
        });
        contextText = buildPendingLayer0Context(
            store.layers,
            entries.map((entry) => entry.snippet),
        );
        progress.update(snapshots.length);
    }

    const commit = await commitLayer0({
        kind: commitKindFor(routePlan),
        snapshot: snapshots[0],
        entries,
        notify,
        progress,
    });
    if (commit === 'queued') {
        return { status: 'blocked', completed: snapshots.length };
    }
    if (commit === 'stale') {
        return { status: 'failed', failed: snapshots.length };
    }
    return { status: 'completed', completed: snapshots.length };
}

/**
 * The verdict for a run that stopped before its commit: only a run that
 * captured nothing at all was idle, everything else reports what it captured.
 * @param {'idle' | 'aborted' | 'failed'} status
 * @param {number} captured - Passages summarized before the run stopped
 * @returns {import('./run-outcome.js').SummarizationRunOutcome}
 */
function verdictFor(status, captured) {
    if (status === 'idle') {
        return captured === 0
            ? { status: 'idle' }
            : { status: 'failed', completed: captured, failed: 1 };
    }
    if (status === 'aborted') {
        return { status: 'aborted', completed: captured };
    }
    return { status: 'failed', completed: captured, failed: 1 };
}

/**
 * Resolve the Passages one plan runs over. The atomic route supplies its
 * partitions; every other route spans its batch turns. Both start a Passage at
 * the summarized boundary, so the Passage covers the user turns that interleave
 * its Batch.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {{ boundary: number, batch: import('./chatutils.js').AssistantTurn[] }} context
 * @returns {{ startIdx: number, endIdx: number }[]}
 */
function resolvePassages(routePlan, { boundary, batch }) {
    if (routePlan?.commitMode === SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS) {
        return (routePlan.partitions || [])
            .filter((partition) => partition?.turns?.length > 0)
            .map((partition) => ({
                startIdx: partition.sourceStartIdx,
                endIdx: partition.sourceEndIdx,
            }));
    }

    if (batch.length === 0) {
        return [];
    }
    const endIdx = getSourceEndIdx(batch[batch.length - 1].index, routePlan?.sourceEndIdx);
    const startIdx = boundary < 0 ? 0 : boundary + 1;
    if (startIdx > endIdx) {
        error(`passageStart (${startIdx}) > endIdx (${endIdx}). Batch already summarized?`);
        return [];
    }
    return [{ startIdx, endIdx }];
}

/**
 * Commit a run's Passages as one transaction as soon as the Foreground Gate
 * allows. A queued commit settles the shared progress when it flushes, so the
 * handle outlives the run that opened it.
 * @param {object} p
 * @param {string} p.kind
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot
 * @param {{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, snippet: SummaryceptionSnippet, profile: import('./call-profile.js').CallProfile}[]} p.entries
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @param {BatchProgressOwner} p.progress
 * @returns {Promise<import('./summarizer-commit.js').CommitResult>}
 */
async function commitLayer0({ kind, snapshot, entries, notify, progress }) {
    return await commitWhenSafe({
        kind,
        snapshot,
        apply: async () => {
            const committed = await commitLayer0Snippets({ entries, notify });
            progress.settle(committed ? BATCH_PROGRESS.UPDATED : BATCH_PROGRESS.FAILED);
            return committed;
        },
    });
}

/**
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @returns {string}
 */
function commitKindFor(routePlan) {
    return routePlan?.commitMode === SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS
        ? 'layer0-atomic-cache'
        : 'layer0';
}

/**
 * Repair ghosting for turns already marked as summarized.
 * @param {import('./chatutils.js').AssistantTurn[]} turns
 * @param {number} boundaryIndex
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter threaded to ghosting progress events
 * @returns {Promise<void>}
 */
async function repairGhosting(turns, boundaryIndex, notify) {
    info('All planned turns are already summarized; repairing ghosting...');
    const turnsToGhost = turns.filter((turn) => turn.index <= boundaryIndex);
    if (turnsToGhost.length > 0) {
        const first = turnsToGhost[0].index;
        const last = turnsToGhost[turnsToGhost.length - 1].index;
        await repairGhostingForRange(first, last, { chatSave: 'deferred', notify });
    }
    await persistChatState({ chatSave: 'deferred' });
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
 * The progress handle opens only after the passage validates so earlier
 * failures never leak it. Every non-success exit settles it here, so the run's
 * caller only maps the returned status.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {{ startIdx: number, endIdx: number }} p.passage
 * @param {string} p.contextText - Prebuilt pending context for later passages
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @param {BatchProgressOwner} p.progress - Shared batch progress owner for this run
 * @param {number} p.total
 * @returns {Promise<{status: 'completed', snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, summary: string, profile: import('./call-profile.js').CallProfile} | {status: 'idle' | 'aborted' | 'failed'}>}
 */
async function runPassage({ chat, store, passage, contextText, notify, progress, total }) {
    const snapshot = await captureLayer0Snapshot({
        chat,
        store,
        passageStart: passage.startIdx,
        endIdx: passage.endIdx,
        contextText,
    });
    tracePassageTokens(snapshot);
    if (!snapshot.passageText.trim()) {
        progress.settle();
        return { status: 'idle' };
    }

    progress.open(total);

    // Every failure routes through the owner so the run's handle settles
    // exactly once, whether this run owns it or shares it across passages.
    let outcome;
    try {
        outcome = await callSummarizer({
            storyTxt: snapshot.passageText,
            contextStr: snapshot.contextText,
            metadata: {
                kind: 'layer0',
                sourceRange: snapshot.sourceRange,
                regexStats: snapshot.passageStats,
            },
            notify,
        });
    } catch (err) {
        progress.settle();
        throw err;
    }
    if (outcome.status === 'aborted') {
        progress.settle(BATCH_PROGRESS.ABORTED);
        return { status: 'aborted' };
    }
    const profile = outcome.status === 'completed' ? outcome.profile : undefined;
    const summary = outcome.status === 'completed' ? outcome.text : '';
    if (!profile || !summary || !isSummarizerOutputSafe(summary, profile)) {
        progress.settle();
        return { status: 'failed' };
    }
    return { status: 'completed', snapshot, summary, profile };
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
 * @param {{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, snippet: SummaryceptionSnippet, profile: import('./call-profile.js').CallProfile}[]} p.entries - Snapshot, prebuilt snippet, and dispatch profile triples.
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter threaded to ghosting
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippets({ entries, notify }) {
    if (
        entries.length === 0 ||
        !entries.every(
            ({ snapshot, snippet, profile }) =>
                isLayer0SnapshotValid(snapshot) && isSummarizerOutputSafe(snippet.text, profile),
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
    return buildMemoryBody(workingLayers) || '(none yet)';
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
