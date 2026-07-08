import {
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
    defaultSettings,
} from './constants.js';
import {
    getChatMetadata,
    getExtensionSettings,
    getName1,
    saveMetadata,
    saveSettingsDebounced,
} from './context.js';

const PROMPT_PRESET_VALUES = Object.freeze(['narrative', 'custom']);
const PROMPT_SETTING_BINDINGS = Object.freeze([
    {
        presetKey: 'summarizerSystemPromptPreset',
        promptKey: 'summarizerSystemPrompt',
    },
    {
        presetKey: 'promptPreset',
        promptKey: 'summarizerUserPrompt',
    },
    {
        presetKey: 'summarizerRepairPromptPreset',
        promptKey: 'summarizerRepairPrompt',
    },
    {
        presetKey: 'promotionSystemPromptPreset',
        promptKey: 'promotionSystemPrompt',
    },
    {
        presetKey: 'promotionPromptPreset',
        promptKey: 'promotionUserPrompt',
    },
    {
        presetKey: 'promotionRepairPromptPreset',
        promptKey: 'promotionRepairPrompt',
    },
]);

/**
 * Get the extension settings object.
 * @returns {ExtensionSettings} The current settings
 */
export function getSettings() {
    const extensionSettings = getExtensionSettings();
    if (!isPlainObject(extensionSettings[MODULE_NAME])) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    const settingsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (settings)
    );
    const defaultsRecord = /** @type {Record<string, unknown>} */ (defaultSettings);
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settingsRecord[key] = defaultsRecord[key];
        }
    }
    normalizeMemorySettings(settings);
    normalizeVerbatimWindowSettings(settings);
    const promptSettingsNormalized = normalizePromptSettings(settings);
    if (promptSettingsNormalized) {
        saveSettingsDebounced();
    }
    return settings;
}

/**
 *
 */
export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get the chat-specific store for summary data.
 * @returns {SummaryceptionStore} The chat store with layers, summarizedUpTo, ghostedIndices
 */
export function getChatStore() {
    const chatMetadata = getChatMetadata();
    if (!isPlainObject(chatMetadata[MODULE_NAME])) {
        chatMetadata[MODULE_NAME] = createDefaultChatStore();
    }
    return normalizeChatStore(chatMetadata[MODULE_NAME]);
}

/**
 *
 */
export async function saveChatStore() {
    getChatStore();
    await saveMetadata();
}

/**
 * Get the current summary-layer mutation epoch.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getSummaryStoreMutationEpoch(store) {
    return normalizeMutationEpoch(store?.mutationEpoch);
}

/**
 * Advance the summary-layer mutation epoch after changing stored snippets.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function bumpSummaryStoreMutationEpoch(store) {
    store.mutationEpoch = getSummaryStoreMutationEpoch(store) + 1;
    return store.mutationEpoch;
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
 * @param {SummaryceptionStore} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
    store.summarizedUpTo = normalizeSummarizedUpTo(store.summarizedUpTo);
    store.ghostedIndices = normalizeGhostedIndices(store.ghostedIndices);
    store.mutationEpoch = normalizeMutationEpoch(store.mutationEpoch);
    return store;
}

/**
 * Normalize memory placement settings in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeMemorySettings(settings) {
    if (!isSettingValue(Object.values(MEMORY_MODES), settings.memoryMode)) {
        settings.memoryMode = defaultSettings.memoryMode;
    }
    if (!isSettingValue(Object.values(MEMORY_POSITIONS), settings.customMemoryPosition)) {
        settings.customMemoryPosition = defaultSettings.customMemoryPosition;
    }
    if (!isSettingValue(Object.values(MEMORY_ROLES), settings.customMemoryRole)) {
        settings.customMemoryRole = defaultSettings.customMemoryRole;
    }
    settings.customMemoryDepth = clampInteger(settings.customMemoryDepth, 0, 10000);
}

/**
 * Check whether a persisted setting is one of the allowed string values.
 * @param {readonly string[]} values
 * @param {unknown} value
 * @returns {boolean}
 */
function isSettingValue(values, value) {
    return values.includes(String(value));
}

/**
 * Normalize retention settings in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeVerbatimWindowSettings(settings) {
    settings.minSummaryTurns = clampInteger(settings.minSummaryTurns, 2, 10);
    settings.maxSummaryTurns = clampInteger(settings.maxSummaryTurns, 3, 20);
    settings.layer0SummaryTokenTarget = clampInteger(settings.layer0SummaryTokenTarget, 80, 500);
    if (settings.maxSummaryTurns < settings.minSummaryTurns) {
        settings.maxSummaryTurns = settings.minSummaryTurns;
    }
    settings.minSummaryBudget = clampToStep(settings.minSummaryBudget, 2000, 16000, 1000);
    settings.verbatimTokenBudget = clampToStep(settings.verbatimTokenBudget, 4000, 64000, 1000);
    settings.memoryTokenBudget = clampToStep(settings.memoryTokenBudget, 4000, 32000, 1000);
    settings.snippetsPerLayer = clampInteger(settings.snippetsPerLayer, 20, 40);
    settings.snippetsPerPromotion = clampInteger(settings.snippetsPerPromotion, 3, 4);
}

function normalizePromptSettings(settings) {
    let changed = false;
    for (const binding of PROMPT_SETTING_BINDINGS) {
        const defaults = /** @type {Record<string, unknown>} */ (defaultSettings);
        const settingsRecord = /** @type {Record<string, unknown>} */ (
            /** @type {unknown} */ (settings)
        );
        const preset = settingsRecord[binding.presetKey];
        const isCustom = preset === 'custom';

        if (!isSettingValue(PROMPT_PRESET_VALUES, preset)) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            settingsRecord[binding.promptKey] = defaults[binding.promptKey];
            changed = true;
            continue;
        }

        const promptText = settingsRecord[binding.promptKey];
        if (isCustom && typeof promptText === 'string' && promptText.trim()) {
            continue;
        }

        if (settingsRecord[binding.presetKey] !== defaults[binding.presetKey]) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            changed = true;
        }
        if (settingsRecord[binding.promptKey] !== defaults[binding.promptKey]) {
            settingsRecord[binding.promptKey] = defaults[binding.promptKey];
            changed = true;
        }
    }
    return changed;
}

function clampInteger(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return min;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
}

function clampToStep(value, min, max, step) {
    const clamped = clampInteger(value, min, max);
    return Math.min(max, Math.max(min, Math.round(clamped / step) * step));
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

function createDefaultChatStore() {
    return {
        layers: [],
        summarizedUpTo: -1,
        ghostedIndices: [],
        mutationEpoch: 0,
    };
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
 * Normalize the summary-layer mutation epoch.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMutationEpoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return 0;
    }
    return Math.max(0, value);
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
    return getName1();
}
