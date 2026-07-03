/**
 * Get a best-effort stable identity for the active chat.
 * @param {object} ctx
 * @returns {string}
 */
export function getChatIdentity(ctx) {
    const context =
        /** @type {{ chat?: Array<Record<string, unknown>>, chatId?: unknown, chat_id?: unknown, chatFile?: unknown, chat_filename?: unknown, characterId?: unknown, character_id?: unknown }} */ (
            ctx
        );
    const direct =
        context.chatId ||
        context.chat_id ||
        context.chatFile ||
        context.chat_filename ||
        context.characterId ||
        context.character_id;

    if (direct) {
        return String(direct);
    }

    const firstMessage = Array.isArray(context.chat) ? context.chat[0] : null;
    const extra = /** @type {{ file?: unknown }} */ (firstMessage?.extra || {});
    const firstId = extra.file || firstMessage?.send_date || firstMessage?.mes;
    return `chat-ref:${firstId || 'empty'}:${context.chat?.length || 0}`;
}

/**
 * Fingerprint the source chat messages covered by a summarization job.
 * @param {Array} chat
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
 * Fingerprint summary layers without including ghosting metadata.
 * @param {Record<string, unknown>} store
 * @returns {string}
 */
export function fingerprintSummaryStore(store) {
    const layers = Array.isArray(store.layers) ? store.layers : [];
    return JSON.stringify(
        layers.map((layer) =>
            (layer || []).map((snippet) => ({
                text: snippet.text,
                turnRange: snippet.turnRange,
                fromLayer: snippet.fromLayer,
                mergedCount: snippet.mergedCount,
                promoted: snippet.promoted,
                seedFromLayer: snippet.seedFromLayer,
            })),
        ),
    );
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
