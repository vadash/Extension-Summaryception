import { MODULE_NAME, defaultSettings } from './constants.js';

/**
 * @typedef {object} SummaryceptionSnippet
 * @property {string} text - Summary text saved for injection
 * @property {[number, number]} [turnRange] - Source chat index range for Layer 0 snippets
 * @property {number} [timestamp] - Last update timestamp
 * @property {boolean} [regenerated] - Whether the snippet was regenerated manually
 * @property {boolean} [promoted] - Whether the snippet was promoted without merging
 * @property {number} [seedFromLayer] - Source layer for seeded promotion
 * @property {number} [fromLayer] - Source layer for merged promotion
 * @property {number} [mergedCount] - Number of snippets merged into this snippet
 */

/**
 * @typedef {object} SummaryceptionStore
 * @property {Array<Array<SummaryceptionSnippet>>} layers - Summary snippets by layer
 * @property {number} summarizedUpTo - Highest summarized chat index, or -1
 * @property {number[]} ghostedIndices - Chat indices hidden by Summaryception
 */

/**
 * Get the extension settings object.
 * @returns {object} The current settings
 */
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 *
 */
export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Get the chat-specific store for summary data.
 * @returns {SummaryceptionStore} The chat store with layers, summarizedUpTo, ghostedIndices
 */
export function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        };
    }
    return normalizeChatStore(chatMetadata[MODULE_NAME]);
}

/**
 *
 */
export async function saveChatStore() {
    getChatStore();
    await SillyTavern.getContext().saveMetadata();
}

/**
 * Calculate the last summarized index covered by contiguous Layer 0 ranges.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function calculateContiguousSummarizedUpTo(store) {
    const ranges = (store.layers[0] || [])
        .map((snippet) => snippet.turnRange)
        .filter(isValidTurnRange)
        .sort((a, b) => a[0] - b[0]);
    let cursor = -1;

    for (const [start, end] of ranges) {
        if (start > cursor + 1) {
            break;
        }
        cursor = Math.max(cursor, end);
    }

    return cursor;
}

/**
 * Normalize persisted chat metadata in place.
 * @param {object} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
    store.summarizedUpTo = normalizeSummarizedUpTo(store.summarizedUpTo);
    store.ghostedIndices = normalizeGhostedIndices(store.ghostedIndices);
    return store;
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
        return layer.filter(isValidSnippet);
    });
}

/**
 * Check whether a persisted snippet is usable.
 * @param {unknown} snippet
 * @returns {snippet is SummaryceptionSnippet}
 */
function isValidSnippet(snippet) {
    if (!isPlainObject(snippet)) {
        return false;
    }
    return typeof snippet.text === 'string';
}

/**
 * Check whether a value is a plain object record.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Normalize the summarized cursor.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeSummarizedUpTo(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return -1;
    }
    return Math.max(-1, value);
}

/**
 * Normalize ghosted message indices.
 * @param {unknown} indices
 * @returns {number[]}
 */
function normalizeGhostedIndices(indices) {
    if (!Array.isArray(indices)) {
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const value of indices) {
        const index = normalizeIndex(value);
        if (index === null || seen.has(index)) {
            continue;
        }
        seen.add(index);
        result.push(index);
    }
    return result;
}

/**
 * Normalize one stored index.
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeIndex(value) {
    const index = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof index !== 'number' || !Number.isFinite(index) || !Number.isInteger(index)) {
        return null;
    }
    return index >= 0 ? index : null;
}

/**
 * Check whether a stored turn range can contribute to cursor coverage.
 * @param {unknown} range
 * @returns {range is [number, number]}
 */
function isValidTurnRange(range) {
    return (
        Array.isArray(range) &&
        range.length >= 2 &&
        Number.isInteger(range[0]) &&
        Number.isInteger(range[1]) &&
        range[0] >= 0 &&
        range[1] >= range[0]
    );
}

/**
 * Get the player's display name.
 * @returns {string} The player name from ST context, or 'User' as fallback
 */
export function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}
