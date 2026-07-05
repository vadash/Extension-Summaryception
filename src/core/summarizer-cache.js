import { LOG_PREFIX } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { getChatStore, saveChatStore } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { buildFullContext, buildPassageFromRangeWithStats } from './chatutils.js';
import { ghostMessagesInRange } from './ghosting.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { commitWhenSafe, updateCommittedInjection } from './summarizer-commit.js';
import {
    fingerprintSourceRange,
    fingerprintSummaryStore,
    getChatIdentity,
    isSameChatSnapshot,
} from './summarizer-snapshot.js';

/**
 * @typedef {object} CacheFlushDraft
 * @property {import('./cache-planner.js').CacheFlushChunk} chunk
 * @property {string} summary
 */

/**
 * @typedef {object} CacheFlushSnapshot
 * @property {string} chatId
 * @property {ChatMessage[]} chatRef
 * @property {number} summarizedUpTo
 * @property {[number, number]} sourceRange
 * @property {string} sourceFingerprint
 * @property {string} summaryStoreFingerprint
 * @property {string} baseContextText
 */

/**
 * Summarize a cache-friendly flush in an all-or-nothing transaction.
 * @param {import('./cache-planner.js').CacheFriendlyPlan} plan
 * @returns {Promise<'applied' | 'queued' | 'stale' | 'failed'>}
 */
export async function summarizeCacheFlush(plan) {
    try {
        return await summarizeCacheFlushCore(plan);
    } catch (err) {
        console.error(LOG_PREFIX, 'summarizeCacheFlush exception:', err);
        return 'failed';
    }
}

async function summarizeCacheFlushCore(plan) {
    if (plan.reason !== 'ready' || plan.chunks.length === 0) {
        return 'failed';
    }

    const chat = getChat();
    const store = getChatStore();
    const snapshot = captureCacheFlushSnapshot({ chat, store, plan });
    const drafts = [];

    for (const chunk of plan.chunks) {
        const draft = await summarizeCacheChunk({ chat, snapshot, chunk, drafts });
        if (!draft) {
            log('Cache-friendly flush failed; leaving memory and chat visibility unchanged.');
            return 'failed';
        }
        drafts.push(draft);
    }

    return await commitWhenSafe({
        kind: 'cache-flush',
        snapshot,
        apply: async () => await commitCacheFlush({ snapshot, drafts }),
    });
}

async function summarizeCacheChunk({ chat, snapshot, chunk, drafts }) {
    const passage = await buildPassageFromRangeWithStats(chat, chunk.startIdx, chunk.endIdx);
    if (!passage.text.trim()) {
        return null;
    }

    const contextText = buildDraftContext(snapshot.baseContextText, drafts);
    trace(
        `Cache chunk ${drafts.length + 1}: indices ${chunk.startIdx}-${chunk.endIdx}, ` +
            `${chunk.assistantTurnCount} assistant turns`,
    );

    const summary = await callSummarizer(passage.text, contextText, {
        kind: 'layer0',
        sourceRange: [chunk.startIdx, chunk.endIdx],
        assistantTurnCount: chunk.assistantTurnCount,
        regexStats: passage.stats,
    });

    return summary ? { chunk, summary } : null;
}

function buildDraftContext(baseContextText, drafts) {
    const draftText = drafts.map((draft) => draft.summary).join(' ');
    if (!draftText) {
        return baseContextText;
    }
    if (!baseContextText || baseContextText === '(none yet)') {
        return draftText;
    }
    return `${baseContextText} ${draftText}`;
}

function captureCacheFlushSnapshot({ chat, store, plan }) {
    const ctx = getContext();
    return {
        chatId: getChatIdentity(ctx),
        chatRef: chat,
        summarizedUpTo: store.summarizedUpTo,
        sourceRange: [plan.flushStartIdx, plan.flushEndIdx],
        sourceFingerprint: fingerprintSourceRange(chat, plan.flushStartIdx, plan.flushEndIdx),
        summaryStoreFingerprint: fingerprintSummaryStore(store),
        baseContextText: buildFullContext(0),
    };
}

async function commitCacheFlush({ snapshot, drafts }) {
    if (!isCacheFlushSnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    const [flushStartIdx, flushEndIdx] = snapshot.sourceRange;
    ensureLayer0(store);

    const timestamp = Date.now();
    for (const draft of drafts) {
        store.layers[0].push({
            text: draft.summary,
            turnRange: [draft.chunk.startIdx, draft.chunk.endIdx],
            timestamp,
        });
    }
    store.summarizedUpTo = Math.max(store.summarizedUpTo, flushEndIdx);

    await saveChatStore();
    await updateCommittedInjection();
    await ghostMessagesInRange(flushStartIdx, flushEndIdx, {
        kind: 'cache-flush-ghost',
        chatSave: 'deferred',
    });
    await persistChatState({ chatSave: 'deferred' });

    log(`Cache-friendly flush committed ${drafts.length} Layer 0 snippets.`);
    return true;
}

function isCacheFlushSnapshotValid(snapshot) {
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

function ensureLayer0(store) {
    if (!store.layers[0]) {
        store.layers[0] = [];
    }
}
