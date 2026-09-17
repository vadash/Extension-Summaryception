/**
 * Falls back to a v4 UUID built from crypto.getRandomValues when
 * crypto.randomUUID is unavailable (insecure HTTP contexts). Single crypto
 * access point (ADR-0001).
 * @returns {string}
 */
export function createUuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
    ].join('-');
}

/**
 * @param {ChatMessage | unknown} message
 * @returns {string | null}
 */
export function ensureMessageScId(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return null;
    }
    const chatMessage = /** @type {ChatMessage} */ (message);
    if (typeof chatMessage.sc_id === 'string' && chatMessage.sc_id.trim() !== '') {
        return chatMessage.sc_id;
    }
    chatMessage.sc_id = createUuid();
    return chatMessage.sc_id;
}

/**
 * @param {ChatMessage[] | unknown} chat
 * @returns {boolean} Whether any message changed.
 */
export function ensureChatScIds(chat) {
    if (!Array.isArray(chat)) {
        return false;
    }
    let changed = false;
    for (const message of chat) {
        const previousId = message?.sc_id;
        const id = ensureMessageScId(message);
        if (id !== null && id !== previousId) {
            changed = true;
        }
    }
    return changed;
}

/**
 * @param {ChatMessage[] | unknown} chat
 * @returns {Map<string, number>}
 */
export function getMessageIndexByScId(chat) {
    const indices = new Map();
    if (!Array.isArray(chat)) {
        return indices;
    }
    for (let index = 0; index < chat.length; index++) {
        const id = chat[index]?.sc_id;
        if (typeof id === 'string' && id.trim() !== '' && !indices.has(id)) {
            indices.set(id, index);
        }
    }
    return indices;
}

/**
 * @param {ChatMessage[] | unknown} chat
 * @param {unknown} ids
 * @returns {number[]}
 */
export function resolveScIdsToIndices(chat, ids) {
    if (!Array.isArray(ids)) {
        return [];
    }
    const messageIndices = getMessageIndexByScId(chat);
    const seenIds = new Set();
    const indices = [];
    for (const id of ids) {
        if (typeof id !== 'string' || id.trim() === '' || seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);
        const index = messageIndices.get(id);
        if (index !== undefined) {
            indices.push(index);
        }
    }
    return indices.sort((a, b) => a - b);
}

/**
 * @param {number[]} indices
 * @returns {Array<[number, number]>}
 */
export function rangesFromSortedIndices(indices) {
    /** @type {Array<[number, number]>} */
    const ranges = [];
    for (const index of indices) {
        const last = ranges[ranges.length - 1];
        if (last && index === last[1] + 1) {
            last[1] = index;
        } else {
            ranges.push([index, index]);
        }
    }
    return ranges;
}
