import { MODULE_NAME } from './constants.js';
import { getChatMetadata, saveMetadata } from './context.js';
import { isPlainObject, normalizeStringArray } from './objects.js';

/**
 * The Summaryception store as chat metadata holds it (ADR-0002): the layers,
 * the Ghosting ownership, the Preserved Message snapshots, and the Mutation
 * Epoch, with the repair a persisted store needs on read.
 */

/**
 * @returns {SummaryceptionStore}
 */
export function getChatStore() {
    const chatMetadata = getChatMetadata();
    if (!isPlainObject(chatMetadata[MODULE_NAME])) {
        chatMetadata[MODULE_NAME] = createDefaultChatStore();
    }
    return normalizeChatStore(chatMetadata[MODULE_NAME]);
}

/**
 * Reads the store first so the persisted metadata keeps the repaired shape.
 * @returns {Promise<void>}
 */
export async function saveChatStore() {
    getChatStore();
    await saveMetadata();
}

/**
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getSummaryStoreMutationEpoch(store) {
    return normalizeMutationEpoch(store?.mutationEpoch);
}

/**
 * Advance the summary-store mutation epoch after any store mutation.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function bumpSummaryStoreMutationEpoch(store) {
    store.mutationEpoch = getSummaryStoreMutationEpoch(store) + 1;
    return store.mutationEpoch;
}

/**
 * Normalize persisted chat metadata in place.
 * @param {SummaryceptionStore} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
    store.preservedMessages = normalizePreservedMessages(store.preservedMessages);
    store.ghostedMessageIds = normalizeStringArray(store.ghostedMessageIds);
    store.mutationEpoch = normalizeMutationEpoch(store.mutationEpoch);
    return /** @type {SummaryceptionStore} */ (store);
}

/**
 * Normalize layer arrays and drop malformed snippets.
 * @param {unknown} layers
 * @returns {Array<Array<SummaryceptionSnippet>>}
 */
function normalizeLayers(layers) {
    if (!Array.isArray(layers)) {
        return [];
    }
    return layers.map((layer) => {
        if (!Array.isArray(layer)) {
            return [];
        }
        return layer.filter(isValidSnippet).map(normalizeSnippet);
    });
}

function createDefaultChatStore() {
    return {
        layers: [],
        ghostedMessageIds: [],
        preservedMessages: [],
        mutationEpoch: 0,
    };
}

/**
 * Drop malformed Preserved Messages and keep the first record for each stable
 * message identity. Approved bodies and handoff state are immutable records.
 * @param {unknown} value
 * @returns {SummaryceptionPreservedMessage[]}
 */
export function normalizePreservedMessages(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const records = [];
    const seen = new Set();
    for (const candidate of value) {
        if (!isValidPreservedMessage(candidate) || seen.has(candidate.id)) {
            continue;
        }
        seen.add(candidate.id);
        records.push(
            Object.freeze({
                id: candidate.id,
                text: candidate.text,
                ...(candidate.currentDateTime
                    ? { currentDateTime: candidate.currentDateTime }
                    : {}),
                handedOff: candidate.handedOff,
            }),
        );
    }
    return records;
}

/**
 * @param {unknown} value
 * @returns {value is SummaryceptionPreservedMessage}
 */
function isValidPreservedMessage(value) {
    if (!isPlainObject(value)) {
        return false;
    }
    return (
        typeof value.id === 'string' &&
        value.id.trim() !== '' &&
        typeof value.text === 'string' &&
        value.text.trim() !== '' &&
        typeof value.handedOff === 'boolean' &&
        (value.currentDateTime === undefined ||
            (typeof value.currentDateTime === 'string' && value.currentDateTime.trim() !== ''))
    );
}

/**
 * @param {unknown} snippet
 * @returns {snippet is SummaryceptionSnippet}
 */
export function isValidSnippet(snippet) {
    return (
        isPlainObject(snippet) &&
        typeof snippet.text === 'string' &&
        normalizeStringArray(snippet.sourceMessageIds).length > 0
    );
}

function normalizeSnippet(snippet) {
    snippet.sourceMessageIds = normalizeStringArray(snippet.sourceMessageIds);
    return snippet;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMutationEpoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return 0;
    }
    return Math.max(0, value);
}
