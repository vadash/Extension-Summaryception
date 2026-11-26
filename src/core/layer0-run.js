import { BATCH_PROGRESS } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { ensureChatScIds } from '../foundation/message-identity.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import {
    getPreservedMessageIndices,
    isPreservedMessage,
    latchPreservedHandoffs,
    reconcilePreservedMessages,
} from './preserved-messages.js';
import { debug, error, info, isTraceEnabled, serializeError, trace } from '../foundation/logger.js';
import { repairGhostingForRange } from './ghosting.js';
import { buildPassageFromRangeWithStats, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { buildSnippetMetadataFromText } from './snippet-metadata.js';
import { commitSnippetMutation } from './snippet-commit.js';
import { buildPassageNameCensus } from './refusal-guard.js';
import { formatTokenValue } from './token-count.js';
import { SUMMARY_COMMIT_MODES } from './summarization-routes.js';
import {
    buildSnapshotBasis,
    fingerprintSourceRange,
    isSnapshotStoreCurrent,
} from './summarizer-snapshot.js';

/**
 * The Layer 0 Run commits one contiguous Passage as one Snippet. Preserved
 * Messages split work so no run crosses a preserved barrier.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {object} p
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter threaded from the engine; a run without one stays silent.
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate - Foreground Gate the commit and the Ghosting repair cross.
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} p.dispatch - Summarizer Dispatch every passage request goes through.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
export async function runLayer0(routePlan, { notify, gate, dispatch }) {
    const progress = createBatchProgress(notify);
    try {
        return await runPassages({ routePlan, notify, progress, gate, dispatch });
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
 * @param {object} p
 * @param {import('./summarization-routes.js').SummaryRoutePlan} p.routePlan
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @param {BatchProgressOwner} p.progress
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} p.dispatch - Summarizer Dispatch every passage request goes through.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function runPassages({ routePlan, notify, progress, gate, dispatch }) {
    const chat = getChat();
    const identitiesChanged = ensureChatScIds(chat);
    const store = getChatStore();
    const preservedChanged = reconcilePreservedMessages(chat, store);
    if (identitiesChanged || preservedChanged) {
        await persistChatState({ chatSave: 'deferred' });
    }
    ensureLayer0(store);

    const boundary = getCurrentSummarizedBoundary(chat, store);
    const turns = Array.isArray(routePlan?.batchTurns) ? routePlan.batchTurns : [];
    const batch = turns.filter((turn) => turn.index > boundary);
    const passage = resolvePassages(routePlan, { boundary, batch, chat, store })[0];

    if (!passage) {
        await repairGhosting(turns, boundary, notify, gate);
        return { status: 'idle' };
    }
    const passageTurns = batch.filter(
        (turn) => turn.index >= passage.startIdx && turn.index <= passage.endIdx,
    );
    info(
        `Summarizing ${passageTurns.length} assistant turns (indices ${passage.startIdx}–${passage.endIdx})`,
    );

    const result = await runPassage({
        chat,
        store,
        passage,
        contextText: buildFullContext(0),
        notify,
        progress,
        total: 1,
        dispatch,
    });
    if (result.status !== 'completed') {
        return verdictFor(result.status);
    }

    const entry = {
        snapshot: result.snapshot,
        snippet: buildLayer0Snippet(result.snapshot, result.summary),
    };
    progress.update(1);
    const commit = await commitLayer0({
        kind: commitKindFor(routePlan),
        entries: [entry],
        notify,
        progress,
        gate,
    });
    if (commit === 'queued') {
        return { status: 'blocked', completed: 1 };
    }
    if (commit === 'stale') {
        return { status: 'failed', failed: 1 };
    }
    return { status: 'completed', completed: 1 };
}

/**
 * @param {'idle' | 'aborted' | 'failed'} status
 * @returns {import('./run-outcome.js').SummarizationRunOutcome}
 */
function verdictFor(status) {
    if (status === 'idle') {
        return { status: 'idle' };
    }
    if (status === 'aborted') {
        return { status: 'aborted', completed: 0 };
    }
    return { status: 'failed', completed: 0, failed: 1 };
}

/**
 * Resolve the one contiguous Passage this run commits. Preserved Messages are
 * hard boundaries, so a stale or discontinuous plan cannot leap across one.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {{ boundary: number, batch: import('./chatutils.js').AssistantTurn[], chat: ChatMessage[], store: SummaryceptionStore }} context
 * @returns {{ startIdx: number, endIdx: number }[]}
 */
function resolvePassages(routePlan, { boundary, batch, chat, store }) {
    if (routePlan?.commitMode === SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS) {
        for (const partition of routePlan.partitions || []) {
            if (!partition?.turns?.some((turn) => turn.index > boundary)) {
                continue;
            }
            const passage = buildContiguousPassage(chat, store, {
                boundary,
                batch,
                startIdx: partition.sourceStartIdx,
                endIdx: partition.sourceEndIdx,
            });
            return passage ? [passage] : [];
        }
        return [];
    }

    if (batch.length === 0) {
        return [];
    }
    const endIdx = getSourceEndIdx(batch[batch.length - 1].index, routePlan?.sourceEndIdx);
    const passage = buildContiguousPassage(chat, store, {
        boundary,
        batch,
        startIdx: routePlan?.sourceStartIdx ?? boundary + 1,
        endIdx,
    });
    return passage ? [passage] : [];
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {object} range
 * @param {number} range.boundary
 * @param {import('./chatutils.js').AssistantTurn[]} range.batch
 * @param {number} range.startIdx
 * @param {number} range.endIdx
 * @returns {{ startIdx: number, endIdx: number } | null}
 */
function buildContiguousPassage(
    chat,
    store,
    { boundary, batch, startIdx: requestedStart, endIdx: requestedEnd },
) {
    let startIdx = Math.max(0, boundary + 1, requestedStart);
    let endIdx = requestedEnd;
    const preservedIndices = getPreservedMessageIndices(chat, store);
    while (preservedIndices.includes(startIdx) && startIdx <= endIdx) {
        startIdx += 1;
    }
    const barrier = preservedIndices.find((index) => index >= startIdx && index <= endIdx);
    if (barrier !== undefined) {
        endIdx = barrier - 1;
    }
    if (
        startIdx > endIdx ||
        !batch.some((turn) => turn.index >= startIdx && turn.index <= endIdx)
    ) {
        return null;
    }
    return { startIdx, endIdx };
}

/**
 * Commit a run's Passages as one transaction as soon as the Foreground Gate
 * allows. A queued commit settles the shared progress when it flushes, so the
 * handle outlives the run that opened it.
 * @param {object} p
 * @param {string} p.kind
 * @param {{snapshot: import('./summarizer-snapshot.js').SummarizationJobSnapshot, snippet: SummaryceptionSnippet}[]} p.entries
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify
 * @param {BatchProgressOwner} p.progress
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate
 * @returns {Promise<import('./foreground-gate.js').CommitResult>}
 */
async function commitLayer0({ kind, entries, notify, progress, gate }) {
    return await gate.commitWhenSafe({
        kind,
        apply: async () => {
            const committed = await commitLayer0Snippets({ entries, notify, gate });
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
 * @param {import('./foreground-gate.js').ForegroundGate} gate
 * @returns {Promise<void>}
 */
async function repairGhosting(turns, boundaryIndex, notify, gate) {
    info('All planned turns are already summarized; repairing ghosting...');
    const turnsToGhost = turns.filter((turn) => turn.index <= boundaryIndex);
    if (turnsToGhost.length > 0) {
        const first = turnsToGhost[0].index;
        const last = turnsToGhost[turnsToGhost.length - 1].index;
        await repairGhostingForRange(first, last, { chatSave: 'deferred', notify, gate });
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
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} p.dispatch - Summarizer Dispatch the request goes through.
 * @returns {Promise<{status: 'completed', snapshot: import('./summarizer-snapshot.js').SummarizationJobSnapshot, summary: string} | {status: 'idle' | 'aborted' | 'failed'}>}
 */
async function runPassage({
    chat,
    store,
    passage,
    contextText,
    notify,
    progress,
    total,
    dispatch,
}) {
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
        outcome = await dispatch({
            storyTxt: snapshot.passageText,
            contextStr: snapshot.contextText,
            metadata: {
                kind: 'layer0',
                sourceRange: snapshot.sourceRange,
                regexStats: snapshot.passageStats,
                passageNames: buildPassageNameCensus(snapshot.passageText).join(', '),
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
    if (outcome.status !== 'completed' || !outcome.text) {
        progress.settle();
        return { status: 'failed' };
    }
    return { status: 'completed', snapshot, summary: outcome.text };
}

/**
 * @param {import('./summarizer-snapshot.js').SummarizationJobSnapshot} snapshot
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
 * @returns {Promise<import('./summarizer-snapshot.js').SummarizationJobSnapshot>}
 */
async function captureLayer0Snapshot({ chat, store, passageStart, endIdx, contextText }) {
    const ctx = getContext();
    const sourceMessageIds = chat
        .slice(passageStart, endIdx + 1)
        .filter((message) => !isPreservedMessage(message, store))
        .map((message) => message?.sc_id);
    if (
        sourceMessageIds.length !== endIdx - passageStart + 1 ||
        sourceMessageIds.some((id) => typeof id !== 'string' || id.trim() === '')
    ) {
        throw new Error('Cannot summarize messages without stable Summaryception IDs.');
    }
    const stableSourceMessageIds = /** @type {string[]} */ (sourceMessageIds);
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
 * the chat array when post-mutation persistence fails. Every entry's snapshot
 * is re-checked here so no caller can commit against a changed chat.
 * @param {object} p
 * @param {{snapshot: import('./summarizer-snapshot.js').SummarizationJobSnapshot, snippet: SummaryceptionSnippet}[]} p.entries - Snapshot and prebuilt snippet pairs.
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter threaded to ghosting
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate - Foreground Gate the Ghosting step defers a hide through.
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippets({ entries, notify, gate }) {
    if (entries.length === 0 || !entries.every(({ snapshot }) => isLayer0SnapshotValid(snapshot))) {
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
            latchPreservedHandoffs(chat, store);
            trace('  Added Layer 0 snippets for current source IDs.');
        },
        {
            chatSave: 'deferred',
            notify,
            gate,
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

/**
 * Revalidate the active chat and store before committing an LLM result.
 * @param {import('./summarizer-snapshot.js').SummarizationJobSnapshot} snapshot
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
