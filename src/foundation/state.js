import {
    MASK_USER_ROLE_MODES,
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    SLIDER_LIMITS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
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
import { resolveScIdsToIndices } from './message-identity.js';
import { createDefaultContinuity, normalizeContinuity } from './continuity.js';
import { clampInteger, clampToStep } from './numeric.js';

const PROMPT_PRESET_VALUES = Object.freeze(['narrative', 'custom']);

/**
 * @returns {ExtensionSettings}
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
    const roleMaskSettingsNormalized = normalizeRoleMaskSettings(settings, hadMaskUserRoleMode);
    normalizeVerbatimWindowSettings(settings);
    normalizeRequestTimeouts(settings);
    const continuitySettingsNormalized = normalizeContinuitySettings(settings);
    const promptSettingsNormalized = normalizePromptSettings(settings);
    if (
        modeSettingsNormalized ||
        memorySettingsNormalized ||
        roleMaskSettingsNormalized ||
        continuitySettingsNormalized ||
        promptSettingsNormalized
    ) {
        saveSettingsDebounced();
    }
    return settings;
}

/**
 * Runtime code should use this when behavior must follow the visible mode.
 * @returns {ExtensionSettings}
 */
export function getEffectiveSettings() {
    const settings = getSettings();
    return settings.uiMode === UI_MODES.OFF ? { ...settings, enabled: false } : settings;
}

/**
 *
 */
export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Keys a defaults reset never touches: the selected memory/UI/config modes,
 * every connection/merge/fallback route setting including per-route timeouts,
 * and debugMode (re-enabled explicitly after the reset loop).
 * @type {Set<string>}
 */
const RESET_PRESERVED_KEYS = new Set([
    'memoryMode',
    'uiMode',
    'configMode',
    'connectionSource',
    'connectionProfileId',
    'requestTimeoutSeconds',
    'mergeConnectionSource',
    'mergeConnectionProfileId',
    'mergeSummarizerResponseLength',
    'mergeRequestTimeoutSeconds',
    'fallbackConnectionSource',
    'fallbackConnectionProfileId',
    'fallbackSummarizerResponseLength',
    'fallbackRequestTimeoutSeconds',
    'debugMode',
]);

const PROMPT_PRESET_TABLES = Object.freeze({
    summarizerSystemPromptPreset: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    promptPreset: PROMPT_PRESETS,
    summarizerRepairPromptPreset: SUMMARIZER_REPAIR_PROMPT_PRESETS,
    promotionSystemPromptPreset: PROMOTION_SYSTEM_PROMPT_PRESETS,
    promotionPromptPreset: PROMOTION_PROMPT_PRESETS,
    promotionRepairPromptPreset: PROMOTION_REPAIR_PROMPT_PRESETS,
});

/**
 * Custom preset selections keep their edited text.
 * @param {ExtensionSettings} settings - Settings object mutated in place.
 * @returns {void}
 */
function resetPromptValues(settings) {
    const defaultsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (defaultSettings)
    );
    const settingsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (settings)
    );
    for (const { presetKey, settingKey } of PROMPT_SETTING_KEYS) {
        if (settingsRecord[presetKey] === 'custom') {
            continue;
        }
        const defaultPreset = defaultsRecord[presetKey];
        settingsRecord[presetKey] = defaultPreset;
        settingsRecord[settingKey] =
            PROMPT_PRESET_TABLES[presetKey][defaultPreset] || defaultsRecord[settingKey];
    }
}

/**
 * Restores every default except the keys in RESET_PRESERVED_KEYS and the
 * prompt profile pairs, which resetPromptValues handles.
 * @returns {void}
 */
export function resetSettingsToDefaults() {
    const s = getSettings();
    const promptKeys = new Set(
        PROMPT_SETTING_KEYS.flatMap(({ presetKey, settingKey }) => [presetKey, settingKey]),
    );
    for (const key of Object.keys(defaultSettings)) {
        if (RESET_PRESERVED_KEYS.has(key) || promptKeys.has(key)) {
            continue;
        }
        const value = defaultSettings[key];
        s[key] = Array.isArray(value) ? [...value] : value;
    }

    resetPromptValues(s);

    // Retention budgets follow the preserved memory mode's preset, not the plain defaults.
    const retentionPreset = MEMORY_MODE_PRESETS[s.memoryMode] || MEMORY_MODE_PRESETS.balanced;
    s.verbatimTokenBudget = retentionPreset.verbatimTokenBudget;
    s.queuedTokenBudget = retentionPreset.queuedTokenBudget;

    // Debug output deliberately re-enables on reset so F12 diagnostics stay available.
    s.debugMode = true;
}

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
 *
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
 * Deduplicates across layers, keeping first-seen order. Ids are compared
 * and kept raw (never trimmed); non-string and blank ids are skipped.
 * @param {Array<Array<SummaryceptionSnippet>> | null | undefined} layers
 * @param {{ layerIndex?: number }} [options] - Read only this layer when given.
 * @returns {string[]}
 */
export function collectSnippetSourceIds(layers, { layerIndex } = {}) {
    const sources = layerIndex === undefined ? layers || [] : [layers?.[layerIndex] || []];
    const ids = [];
    const seen = new Set();
    for (const layer of sources) {
        for (const snippet of layer || []) {
            for (const id of snippet?.sourceMessageIds || []) {
                if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) {
                    continue;
                }
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}

/**
 * Resolve the highest current chat index owned by a Layer 0 snippet.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getCurrentSummarizedBoundary(chat, store) {
    const sourceMessageIds = collectSnippetSourceIds(store?.layers, { layerIndex: 0 });
    const indices = resolveScIdsToIndices(chat, sourceMessageIds);
    return indices.length > 0 ? indices[indices.length - 1] : -1;
}

/**
 * Normalize persisted chat metadata in place.
 * @param {SummaryceptionStore} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
    store.ghostedMessageIds = normalizeStringArray(store.ghostedMessageIds);
    store.mutationEpoch = normalizeMutationEpoch(store.mutationEpoch);
    store.continuity = normalizeContinuity(store.continuity);
    return /** @type {SummaryceptionStore} */ (store);
}

/**
 * Normalize memory placement settings in place.
 * @param {ExtensionSettings} settings
 * @returns {boolean} Whether settings were changed.
 */
function normalizeMemorySettings(settings) {
    let changed = false;
    if (settings.memoryMode === 'append_only') {
        settings.memoryMode = MEMORY_MODES.PREFIX_CACHE;
        changed = true;
    }
    const validModes = [MEMORY_MODES.BALANCED, MEMORY_MODES.PREFIX_CACHE];
    if (!isSettingValue(validModes, settings.memoryMode)) {
        settings.memoryMode = defaultSettings.memoryMode;
        changed = true;
    }
    if (!isSettingValue(['default', 'profile'], settings.connectionSource)) {
        settings.connectionSource = defaultSettings.connectionSource;
        changed = true;
    }
    if (!isSettingValue(['inherit', 'profile'], settings.mergeConnectionSource)) {
        settings.mergeConnectionSource = defaultSettings.mergeConnectionSource;
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
    const customMemoryDepth = clampInteger(
        settings.customMemoryDepth,
        SLIDER_LIMITS.customMemoryDepth.MIN,
        SLIDER_LIMITS.customMemoryDepth.MAX,
    );
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
    const validMode =
        hadMode && isSettingValue(Object.values(MASK_USER_ROLE_MODES), settings.maskUserRoleMode);
    if (validMode) {
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
 * Coerce the Continuity Auditor toggle to a strict boolean; stored garbage
 * reads as off instead of tripping the runner gate.
 * @param {ExtensionSettings} settings
 * @returns {boolean} Whether settings were changed.
 */
function normalizeContinuitySettings(settings) {
    const value = settings.continuityEnabled === true;
    if (settings.continuityEnabled === value) {
        return false;
    }
    settings.continuityEnabled = value;
    return true;
}

/**
 * Normalize retention settings in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeVerbatimWindowSettings(settings) {
    settings.advancedModelContext = clampToStep(
        settings.advancedModelContext,
        SLIDER_LIMITS.advancedModelContext.MIN,
        SLIDER_LIMITS.advancedModelContext.MAX,
        SLIDER_LIMITS.advancedModelContext.STEP,
    );
    settings.minSummaryTurns = clampInteger(
        settings.minSummaryTurns,
        SLIDER_LIMITS.minSummaryTurns.MIN,
        SLIDER_LIMITS.minSummaryTurns.MAX,
    );
    settings.maxSummaryTurns = clampInteger(
        settings.maxSummaryTurns,
        SLIDER_LIMITS.maxSummaryTurns.MIN,
        SLIDER_LIMITS.maxSummaryTurns.MAX,
    );
    settings.layer0SummaryTokenTarget = clampInteger(
        settings.layer0SummaryTokenTarget,
        SLIDER_LIMITS.layer0SummaryTokenTarget.MIN,
        SLIDER_LIMITS.layer0SummaryTokenTarget.MAX,
    );
    settings.maxL0SourceTokens = clampToStep(
        settings.maxL0SourceTokens,
        SLIDER_LIMITS.maxL0SourceTokens.MIN,
        SLIDER_LIMITS.maxL0SourceTokens.MAX,
        SLIDER_LIMITS.maxL0SourceTokens.STEP,
    );
    settings.verbatimTokenBudget = clampToStep(
        settings.verbatimTokenBudget,
        SLIDER_LIMITS.verbatimTokenBudget.MIN,
        SLIDER_LIMITS.verbatimTokenBudget.MAX,
        SLIDER_LIMITS.verbatimTokenBudget.STEP,
    );
    settings.queuedTokenBudget = clampToStep(
        settings.queuedTokenBudget,
        SLIDER_LIMITS.queuedTokenBudget.MIN,
        SLIDER_LIMITS.queuedTokenBudget.MAX,
        SLIDER_LIMITS.queuedTokenBudget.STEP,
    );
    settings.memoryTokenBudget = clampToStep(
        settings.memoryTokenBudget,
        SLIDER_LIMITS.memoryTokenBudget.MIN,
        SLIDER_LIMITS.memoryTokenBudget.MAX,
        SLIDER_LIMITS.memoryTokenBudget.STEP,
    );
    settings.snippetsPerLayer = clampInteger(
        settings.snippetsPerLayer,
        SLIDER_LIMITS.snippetsPerLayer.MIN,
        SLIDER_LIMITS.snippetsPerLayer.MAX,
    );
    settings.snippetsPerPromotion = clampInteger(
        settings.snippetsPerPromotion,
        SLIDER_LIMITS.snippetsPerPromotion.MIN,
        SLIDER_LIMITS.snippetsPerPromotion.MAX,
    );
    settings.cacheTtlMinutes = clampToStep(
        settings.cacheTtlMinutes,
        SLIDER_LIMITS.cacheTtlMinutes.MIN,
        SLIDER_LIMITS.cacheTtlMinutes.MAX,
        SLIDER_LIMITS.cacheTtlMinutes.STEP,
    );
    enforceRetentionInvariants(settings);
}

/**
 * Enforce the cross-setting retention invariants: maxSummaryTurns never
 * drops below minSummaryTurns, and minSummaryBudget never exceeds the
 * Layer 0 source token cap. Mutates the settings object in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
export function enforceRetentionInvariants(settings) {
    if (settings.maxSummaryTurns < settings.minSummaryTurns) {
        settings.maxSummaryTurns = settings.minSummaryTurns;
    }
    const sourceCap = Math.max(
        SLIDER_LIMITS.maxL0SourceTokens.MIN,
        Number(settings.maxL0SourceTokens) || defaultSettings.maxL0SourceTokens,
    );
    settings.minSummaryBudget = clampToStep(
        settings.minSummaryBudget,
        SLIDER_LIMITS.minSummaryBudget.MIN,
        Math.min(SLIDER_LIMITS.minSummaryBudget.MAX, sourceCap),
        SLIDER_LIMITS.minSummaryBudget.STEP,
    );
}

/**
 * Clamp the three per-route request timeouts (in seconds) to the slider
 * bounds: Layer 0, L1+ merge, and the fallback route.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeRequestTimeouts(settings) {
    settings.requestTimeoutSeconds = clampToStep(
        settings.requestTimeoutSeconds,
        SLIDER_LIMITS.requestTimeoutSeconds.MIN,
        SLIDER_LIMITS.requestTimeoutSeconds.MAX,
        SLIDER_LIMITS.requestTimeoutSeconds.STEP,
    );
    settings.mergeRequestTimeoutSeconds = clampToStep(
        settings.mergeRequestTimeoutSeconds,
        SLIDER_LIMITS.mergeRequestTimeoutSeconds.MIN,
        SLIDER_LIMITS.mergeRequestTimeoutSeconds.MAX,
        SLIDER_LIMITS.mergeRequestTimeoutSeconds.STEP,
    );
    settings.fallbackRequestTimeoutSeconds = clampToStep(
        settings.fallbackRequestTimeoutSeconds,
        SLIDER_LIMITS.fallbackRequestTimeoutSeconds.MIN,
        SLIDER_LIMITS.fallbackRequestTimeoutSeconds.MAX,
        SLIDER_LIMITS.fallbackRequestTimeoutSeconds.STEP,
    );
}

function normalizeModeSettings(settings, hadMode) {
    if (!hadMode || !isSettingValue(Object.values(UI_MODES), settings.uiMode)) {
        settings.uiMode = settings.enabled === false ? UI_MODES.OFF : defaultSettings.uiMode;
    }

    // configMode tracks the Easy/Advanced complexity panel independently of
    // on/off, so config stays visible and editable even when the extension
    // is off.
    if (
        !Object.hasOwn(settings, 'configMode') ||
        !isSettingValue([UI_MODES.EASY, UI_MODES.ADVANCED], settings.configMode)
    ) {
        settings.configMode =
            settings.uiMode === UI_MODES.ADVANCED ? UI_MODES.ADVANCED : defaultSettings.configMode;
    }

    const nextEnabled = settings.uiMode !== UI_MODES.OFF;
    const changed = !hadMode || settings.enabled !== nextEnabled;
    settings.enabled = nextEnabled;
    return changed;
}

function deriveEasySourceCap(contextTokens) {
    const context = clampToStep(
        contextTokens,
        SLIDER_LIMITS.advancedModelContext.MIN,
        SLIDER_LIMITS.advancedModelContext.MAX,
        SLIDER_LIMITS.advancedModelContext.STEP,
    );
    return Math.min(
        SLIDER_LIMITS.maxL0SourceTokens.MAX,
        Math.max(SLIDER_LIMITS.maxL0SourceTokens.MIN, Math.floor(context * 0.5)),
    );
}

/**
 * Derive Advanced engine mechanics from the model-context field.
 * Mutates settings in place. Fires only when the user edits Model context.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
export function deriveAdvancedEngineTuning(settings) {
    const sourceCap = deriveEasySourceCap(settings.advancedModelContext);
    settings.maxL0SourceTokens = sourceCap;
    settings.minSummaryBudget = Math.min(SLIDER_LIMITS.minSummaryBudget.MAX, sourceCap);
    settings.layer0SummaryTokenTarget = clampToStep(
        Number(settings.memoryTokenBudget) * 0.02,
        SLIDER_LIMITS.layer0SummaryTokenTarget.MIN,
        SLIDER_LIMITS.layer0SummaryTokenTarget.MAX,
        SLIDER_LIMITS.layer0SummaryTokenTarget.STEP,
    );
}

function normalizePromptSettings(settings) {
    let changed = false;
    for (const binding of PROMPT_SETTING_KEYS) {
        const defaults = /** @type {Record<string, unknown>} */ (defaultSettings);
        const settingsRecord = /** @type {Record<string, unknown>} */ (
            /** @type {unknown} */ (settings)
        );
        const preset = settingsRecord[binding.presetKey];
        const isCustom = preset === 'custom';

        if (!isSettingValue(PROMPT_PRESET_VALUES, preset)) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            settingsRecord[binding.settingKey] = defaults[binding.settingKey];
            changed = true;
            continue;
        }

        const promptText = settingsRecord[binding.settingKey];
        if (isCustom && typeof promptText === 'string' && promptText.trim()) {
            continue;
        }

        if (settingsRecord[binding.presetKey] !== defaults[binding.presetKey]) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            changed = true;
        }
        if (settingsRecord[binding.settingKey] !== defaults[binding.settingKey]) {
            settingsRecord[binding.settingKey] = defaults[binding.settingKey];
            changed = true;
        }
    }
    return changed;
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
        mutationEpoch: 0,
        continuity: createDefaultContinuity(),
    };
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
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Normalize a stable message ID array.
 * @param {unknown} values
 * @returns {string[]}
 */
function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || value.trim() === '' || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
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

/**
 * @returns {string} The player name from ST context, or 'User' as fallback
 */
export function getPlayerName() {
    return getName1();
}
