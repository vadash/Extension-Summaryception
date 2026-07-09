import { getSummaryStoreMutationEpoch } from '../foundation/state.js';

/**
 * Get a best-effort stable identity for the active chat.
 * @param {object} ctx
 * @returns {string}
 */
export function getChatIdentity(ctx) {
    const context =
        /** @type {{ chat?: ChatMessage[], chatId?: unknown, chat_id?: unknown, chatFile?: unknown, chat_filename?: unknown, characterId?: unknown, character_id?: unknown }} */ (
            ctx
        );
    const direct = firstTruthy([
        context.chatId,
        context.chat_id,
        context.chatFile,
        context.chat_filename,
        context.characterId,
        context.character_id,
    ]);

    if (direct) {
        return String(direct);
    }

    const firstMessage = Array.isArray(context.chat) ? context.chat[0] : null;
    const extra = /** @type {{ file?: unknown }} */ (firstMessage?.extra || {});
    const firstId = firstTruthy([extra.file, firstMessage?.send_date, firstMessage?.mes]);
    return `chat-ref:${firstId || 'empty'}:${context.chat?.length || 0}`;
}

function firstTruthy(values) {
    return values.find(Boolean);
}

/**
 * Fingerprint the source chat messages covered by a summarization job.
 * @param {ChatMessage[]} chat
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {string}
 */
export function fingerprintSourceRange(chat, startIdx, endIdx) {
    const messages = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chat[i];
        messages.push([
            i,
            msg?.mes || '',
            Boolean(msg?.is_user),
            Boolean(msg?.is_system),
            Boolean(msg?.is_hidden),
            Boolean(msg?.extra?.sc_ghosted),
        ]);
    }
    return JSON.stringify(messages);
}

/**
 * Get the summary-layer mutation epoch used by in-flight summarization snapshots.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getSummaryStoreSnapshotEpoch(store) {
    return getSummaryStoreMutationEpoch(store);
}

/**
 * Check whether the active chat still matches a captured snapshot.
 * @param {object} snapshot
 * @param {object} ctx
 * @returns {boolean}
 */
export function isSameChatSnapshot(snapshot, ctx) {
    const snap = /** @type {{ chatId?: unknown, chatRef?: unknown }} */ (snapshot);
    const context = /** @type {{ chat?: unknown }} */ (ctx);
    return snap.chatId === getChatIdentity(ctx) && snap.chatRef === context.chat;
}
