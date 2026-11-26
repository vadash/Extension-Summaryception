import { getChat } from '../foundation/context.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    normalizePreservedMessages,
    saveChatStore,
} from '../foundation/chat-store.js';
import { getMessageIndexByScId, resolveScIdsToIndices } from '../foundation/message-identity.js';
import { formatMessageSpeakerLine, getPromptDepthsByChatIndex } from './chatutils.js';
import { unmaskGuardText } from './guard-mask.js';
import { normalizeCurrentDateTime } from './snippet-metadata.js';
import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { applyRegexToMessage } from './regex-proxy.js';

/**
 * @param {SummaryceptionStore} [store]
 * @returns {SummaryceptionPreservedMessage[]}
 */
export function getPreservedMessages(store = getChatStore()) {
    return normalizePreservedMessages(store?.preservedMessages);
}

/**
 * @param {SummaryceptionStore} [store]
 * @returns {string[]}
 */
export function getPreservedMessageIds(store = getChatStore()) {
    return getPreservedMessages(store).map((record) => record.id);
}

/**
 * @param {SummaryceptionStore} [store]
 * @returns {string[]}
 */
export function getHandedOffPreservedMessageIds(store = getChatStore()) {
    return getPreservedMessages(store)
        .filter((record) => record.handedOff)
        .map((record) => record.id);
}

/**
 * @param {ChatMessage | undefined} message
 * @param {SummaryceptionStore} [store]
 * @returns {boolean}
 */
export function isPreservedMessage(message, store = getChatStore()) {
    if (!store || typeof store !== 'object') {
        store = getChatStore();
    }
    const id = message?.sc_id;
    const records = store.preservedMessages;
    return (
        typeof id === 'string' &&
        id.trim() !== '' &&
        Array.isArray(records) &&
        records.some(
            (record) =>
                record?.id === id &&
                typeof record.text === 'string' &&
                record.text.trim() !== '' &&
                typeof record.handedOff === 'boolean' &&
                (record.currentDateTime === undefined ||
                    (typeof record.currentDateTime === 'string' &&
                        record.currentDateTime.trim() !== '')),
        )
    );
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} [store]
 * @returns {number[]}
 */
export function getPreservedMessageIndices(chat, store = getChatStore()) {
    return resolveScIdsToIndices(chat, getPreservedMessageIds(store));
}

/**
 * Drop records whose stable source identity no longer resolves. The caller
 * persists the repaired store through the normal Chat Persistence owner.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {boolean} Whether the store changed.
 */
export function reconcilePreservedMessages(chat, store) {
    const previous = Array.isArray(store.preservedMessages) ? store.preservedMessages : [];
    const liveIds = new Set(
        Array.isArray(chat)
            ? chat
                  .map((message) => message?.sc_id)
                  .filter((id) => typeof id === 'string' && id.trim() !== '')
            : [],
    );
    const next = normalizePreservedMessages(previous).filter((record) => liveIds.has(record.id));
    const changed =
        previous.length !== next.length ||
        next.some((record, index) => !samePreservedRecord(previous[index], record));
    store.preservedMessages = next;
    if (changed) {
        bumpSummaryStoreMutationEpoch(store);
    }
    return changed;
}

/**
 * @param {SummaryceptionPreservedMessage | undefined} left
 * @param {SummaryceptionPreservedMessage | undefined} right
 * @returns {boolean}
 */
function samePreservedRecord(left, right) {
    return (
        left?.id === right?.id &&
        left?.text === right?.text &&
        left?.currentDateTime === right?.currentDateTime &&
        left?.handedOff === right?.handedOff
    );
}

/**
 * @param {ChatMessage | undefined} message
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} [store]
 * @returns {{ eligible: boolean, reason: string, index?: number }}
 */
export function getPreservationEligibility(message, chat, store = getChatStore()) {
    const id = message?.sc_id;
    const index = typeof id === 'string' ? getMessageIndexByScId(chat).get(id) : undefined;
    if (!message || index === undefined) {
        return { eligible: false, reason: 'missing-identity' };
    }
    if (message.is_system || message.extra?.type) {
        return { eligible: false, reason: 'system', index };
    }
    if (message.is_hidden) {
        return { eligible: false, reason: 'hidden', index };
    }
    if (typeof message.is_user !== 'boolean' || !String(message.mes || '').trim()) {
        return { eligible: false, reason: 'empty', index };
    }
    if (index <= getCurrentSummarizedBoundary(chat, store)) {
        return { eligible: false, reason: 'summarized', index };
    }
    if (isPreservedMessage(message, store)) {
        return { eligible: false, reason: 'preserved', index };
    }
    return { eligible: true, reason: 'eligible', index };
}

/**
 * Build the exact speaker-labelled body proposed for approval. Scene Time comes
 * only from preceding Snippet memory, never from host message dates.
 * @param {ChatMessage | undefined} message
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} [_settings]
 * @returns {Promise<SummaryceptionPreservedMessage | null>}
 */
export async function buildPreservedMessageSnapshot(message, chat, store, _settings) {
    const eligibility = getPreservationEligibility(message, chat, store);
    const index = eligibility.index;
    if (
        !eligibility.eligible ||
        !message ||
        typeof message.sc_id !== 'string' ||
        index === undefined
    ) {
        return null;
    }
    const rawText = String(message.mes || '').trim();
    const depth = getPromptDepthsByChatIndex(chat).get(index);
    const rendered = await applyRegexToMessage(rawText, Boolean(message.is_user), depth);
    const body = escapePreservedTags(unmaskGuardText(rendered));
    if (!body.trim()) {
        return null;
    }
    const currentDateTime = findPrecedingSceneTime(chat, store, index);
    return Object.freeze({
        id: message.sc_id,
        text: formatMessageSpeakerLine(message, body),
        ...(currentDateTime ? { currentDateTime } : {}),
        handedOff: false,
    });
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapePreservedTags(text) {
    return text
        .replaceAll('</preserved>', '&lt;/preserved&gt;')
        .replaceAll('<preserved>', '&lt;preserved&gt;');
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {number} messageIndex
 * @returns {string | undefined}
 */
function findPrecedingSceneTime(chat, store, messageIndex) {
    let nearestEnd = -1;
    let sceneTime;
    for (const layer of store.layers || []) {
        for (const snippet of layer || []) {
            const indices = resolveScIdsToIndices(chat, snippet?.sourceMessageIds);
            const end = indices.at(-1);
            const candidate =
                typeof snippet?.currentDateTime === 'string' ? snippet.currentDateTime.trim() : '';
            if (
                end === undefined ||
                end >= messageIndex ||
                end < nearestEnd ||
                !candidate ||
                candidate.toLowerCase() === 'unknown'
            ) {
                continue;
            }
            nearestEnd = end;
            sceneTime = candidate;
        }
    }
    return sceneTime ? normalizeCurrentDateTime(sceneTime) : undefined;
}

/**
 * Persist an approved snapshot with the Mutation Epoch. Before handoff the
 * record changes neither Ghosting ownership nor Memory Injection.
 * @param {SummaryceptionPreservedMessage} record
 * @returns {Promise<{ status: 'preserved' | 'already-preserved' | 'missing' | 'ineligible', epoch?: number }>}
 */
export async function commitPreservedMessage(record) {
    const store = getChatStore();
    const chat = getChat();
    const snapshot = normalizePreservedMessages([record])[0];
    const index = snapshot ? getMessageIndexByScId(chat).get(snapshot.id) : undefined;
    if (!snapshot || index === undefined) {
        return { status: 'missing' };
    }
    if (isPreservedMessage(chat[index], store)) {
        return { status: 'already-preserved' };
    }
    if (!getPreservationEligibility(chat[index], chat, store).eligible) {
        return { status: 'ineligible' };
    }
    const previous = store.preservedMessages;
    const previousEpoch = store.mutationEpoch;
    store.preservedMessages = [...previous, snapshot];
    const epoch = bumpSummaryStoreMutationEpoch(store);
    try {
        await saveChatStore();
    } catch (error) {
        store.preservedMessages = previous;
        store.mutationEpoch = previousEpoch;
        throw error;
    }
    return { status: 'preserved', epoch };
}

/**
 * Latch the one-way handoff after a later Layer 0 commit advances across the
 * preserved source position. Snippet deletion and Promotion cannot reverse it.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {boolean} Whether any record latched.
 */
export function latchPreservedHandoffs(chat, store) {
    const boundary = getCurrentSummarizedBoundary(chat, store);
    const messageIndices = getMessageIndexByScId(chat);
    let changed = false;
    store.preservedMessages = store.preservedMessages.map((record) => {
        const index = messageIndices.get(record.id);
        if (record.handedOff || index === undefined || index > boundary) {
            return record;
        }
        changed = true;
        return Object.freeze({ ...record, handedOff: true });
    });
    return changed;
}
