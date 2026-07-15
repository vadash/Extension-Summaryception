import {
    BATCH_TRIGGER_LIMITS,
    EASY_CONTEXT_LIMITS,
    EASY_MEMORY_LIMITS,
    L0_SOURCE_LIMITS,
    MASK_USER_ROLE_MODES,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
    UI_MODES,
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
    const hadUiMode = Object.hasOwn(settings, 'uiMode');
    const hadMaskUserRoleMode = Object.hasOwn(settings, 'maskUserRoleMode');
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settingsRecord[key] = defaultsRecord[key];
        }
    }
    const modeSettingsNormalized = normalizeModeSettings(settings, hadUiMode);
    const memorySettingsNormalized = normalizeMemorySettings(settings);
    const roleMaskSettingsNormalized = normalizeRoleMaskSettings(
        settings,
        hadMaskUserRoleMode,
    );
    normalizeVerbatimWindowSettings(settings);
    const promptSettingsNormalized = normalizePromptSettings(settings);
    if (
        modeSettingsNormalized ||
        memorySettingsNormalized ||
        roleMaskSettingsNormalized ||
        promptSettingsNormalized
    ) {
        saveSettingsDebounced();
    }
    return settings;
}

/**
 * Get settings after applying the selected Easy/Advanced operating mode.
 * Runtime code should use this when behavior must follow the visible mode.
 * @returns {ExtensionSettings}
 */
export function getEffectiveSettings() {
    const settings = getSettings();
    if (settings.uiMode === UI_MODES.ADVANCED) {
        return settings;
    }
    if (settings.uiMode === UI_MODES.OFF) {
        return { ...settings, enabled: false };
    }
    return buildEasyEffectiveSettings(settings);
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
 * @returns {boolean} Whether settings were changed.
 */
function normalizeMemorySettings(settings) {
    let changed = false;
    if (!isSettingValue([MEMORY_MODES.STANDARD, MEMORY_MODES.CACHE], settings.memoryMode)) {
        settings.memoryMode = defaultSettings.memoryMode;
        changed = true;
    }
    if (!isSettingValue([MEMORY_MODES.STANDARD, MEMORY_MODES.CACHE], settings.easyMemoryMode)) {
        settings.easyMemoryMode = defaultSettings.easyMemoryMode;
        changed = true;
    }
    if (!isSettingValue(['default', 'profile'], settings.easyConnectionSource)) {
        settings.easyConnectionSource = defaultSettings.easyConnectionSource;
        changed = true;
    }
    if (!isSettingValue(['inherit', 'profile'], settings.easyMergeConnectionSource)) {
        settings.easyMergeConnectionSource = defaultSettings.easyMergeConnectionSource;
        changed = true;
    }
    if (!isSettingValue(Object.values(MEMORY_POSITIONS), settings.customMemoryPosition)) {
        settings.customMemoryPosition = defaultSettings.customMemoryPosition;
        changed = true;
    }
    if (!isSettingValue(Object.values(MEMORY_ROLES), settings.customMemoryRole)) {
        settings.customMemoryRole = defaultSettings.customMemoryRole;
        changed = true;
    }
    const customMemoryDepth = clampInteger(settings.customMemoryDepth, 0, 10000);
    if (settings.customMemoryDepth !== customMemoryDepth) {
        settings.customMemoryDepth = customMemoryDepth;
        changed = true;
    }
    return changed;
}

/**
 * Normalize request-only user-role masking settings in place.
 * @param {ExtensionSettings} settings
 * @param {boolean} hadMode
 * @returns {boolean} Whether settings were changed.
 */
function normalizeRoleMaskSettings(settings, hadMode) {
    if (
        hadMode &&
        isSettingValue(Object.values(MASK_USER_ROLE_MODES), settings.maskUserRoleMode)
    ) {
        return false;
    }
    settings.maskUserRoleMode = defaultSettings.maskUserRoleMode;
    return true;
}

/**
 * Check whether a persisted setting is one of the allowed string values.
 * @param {ReadonlyArray<string>} values
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
    settings.easySummarizerContextTokens = clampToStep(
        settings.easySummarizerContextTokens,
        EASY_CONTEXT_LIMITS.MIN,
        EASY_CONTEXT_LIMITS.MAX,
        EASY_CONTEXT_LIMITS.STEP,
    );
    settings.easyMemoryTokenBudget = clampToStep(
        settings.easyMemoryTokenBudget,
        EASY_MEMORY_LIMITS.MIN,
        EASY_MEMORY_LIMITS.MAX,
        EASY_MEMORY_LIMITS.STEP,
    );
    settings.minSummaryTurns = clampInteger(settings.minSummaryTurns, 2, 10);
    settings.maxSummaryTurns = clampInteger(settings.maxSummaryTurns, 3, 20);
    settings.layer0SummaryTokenTarget = clampInteger(settings.layer0SummaryTokenTarget, 80, 500);
    settings.maxL0SourceTokens = clampToStep(
        settings.maxL0SourceTokens,
        L0_SOURCE_LIMITS.MIN,
        L0_SOURCE_LIMITS.MAX,
        L0_SOURCE_LIMITS.STEP,
    );
    if (settings.maxSummaryTurns < settings.minSummaryTurns) {
        settings.maxSummaryTurns = settings.minSummaryTurns;
    }
    const sourceCap = Math.max(
        L0_SOURCE_LIMITS.MIN,
        Number(settings.maxL0SourceTokens) || defaultSettings.maxL0SourceTokens,
    );
    settings.minSummaryBudget = clampToStep(
        settings.minSummaryBudget,
        BATCH_TRIGGER_LIMITS.MIN,
        Math.min(BATCH_TRIGGER_LIMITS.MAX, sourceCap),
        BATCH_TRIGGER_LIMITS.STEP,
    );
    settings.verbatimTokenBudget = clampToStep(settings.verbatimTokenBudget, 4000, 64000, 1000);
    settings.memoryTokenBudget = clampToStep(settings.memoryTokenBudget, 4000, 32000, 1000);
    settings.snippetsPerLayer = clampInteger(settings.snippetsPerLayer, 20, 40);
    settings.snippetsPerPromotion = clampInteger(settings.snippetsPerPromotion, 3, 4);
}

function normalizeModeSettings(settings, hadMode) {
    if (!hadMode || !isSettingValue(Object.values(UI_MODES), settings.uiMode)) {
        settings.uiMode = settings.enabled === false ? UI_MODES.OFF : defaultSettings.uiMode;
    }

    const nextEnabled = settings.uiMode !== UI_MODES.OFF;
    const changed = !hadMode || settings.enabled !== nextEnabled;
    settings.enabled = nextEnabled;
    return changed;
}

function buildEasyEffectiveSettings(settings) {
    const effective = /** @type {ExtensionSettings} */ ({
        ...structuredClone(defaultSettings),
        uiMode: UI_MODES.EASY,
        enabled: true,
        easySummarizerContextTokens: settings.easySummarizerContextTokens,
        easyMemoryTokenBudget: settings.easyMemoryTokenBudget,
        easyMemoryMode: settings.easyMemoryMode,
        easyConnectionSource: settings.easyConnectionSource,
        easyConnectionProfileId: settings.easyConnectionProfileId,
        easyMergeConnectionSource: settings.easyMergeConnectionSource,
        easyMergeConnectionProfileId: settings.easyMergeConnectionProfileId,
    });

    const sourceCap = deriveEasySourceCap(settings.easySummarizerContextTokens);
    effective.maxL0SourceTokens = sourceCap;
    effective.minSummaryBudget = sourceCap;
    effective.memoryMode = settings.easyMemoryMode;
    effective.verbatimTokenBudget =
        settings.easyMemoryMode === MEMORY_MODES.CACHE
            ? 32000
            : defaultSettings.verbatimTokenBudget;
    effective.memoryTokenBudget = settings.easyMemoryTokenBudget;
    effective.connectionSource = settings.easyConnectionSource;
    effective.connectionProfileId =
        settings.easyConnectionSource === 'profile' ? settings.easyConnectionProfileId : '';
    effective.mergeConnectionSource = settings.easyMergeConnectionSource;
    effective.mergeConnectionProfileId =
        settings.easyMergeConnectionSource === 'profile'
            ? settings.easyMergeConnectionProfileId
            : '';

    copyFallbackRouteSettings(effective, settings);
    return effective;
}

function deriveEasySourceCap(contextTokens) {
    const context = clampToStep(
        contextTokens,
        EASY_CONTEXT_LIMITS.MIN,
        EASY_CONTEXT_LIMITS.MAX,
        EASY_CONTEXT_LIMITS.STEP,
    );
    return Math.min(
        L0_SOURCE_LIMITS.MAX,
        Math.max(L0_SOURCE_LIMITS.MIN, Math.floor(context * 0.5)),
    );
}

function copyFallbackRouteSettings(effective, settings) {
    if (settings.fallbackConnectionSource === 'disabled') {
        return;
    }
    effective.ollamaUrl = settings.ollamaUrl;
    effective.ollamaModelsCache = settings.ollamaModelsCache;
    effective.openaiUrl = settings.openaiUrl;
    effective.openaiKey = settings.openaiKey;
    effective.fallbackConnectionSource = settings.fallbackConnectionSource;
    effective.fallbackSummarizerResponseLength = settings.fallbackSummarizerResponseLength;
    effective.fallbackConnectionProfileId = settings.fallbackConnectionProfileId;
    effective.fallbackOllamaModel = settings.fallbackOllamaModel;
    effective.fallbackOpenaiModel = settings.fallbackOpenaiModel;
    effective.fallbackOpenaiMaxTokens = settings.fallbackOpenaiMaxTokens;
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
