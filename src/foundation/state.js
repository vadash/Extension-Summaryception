import {
    AUDITOR_PROMPT_PRESETS,
    AUDITOR_SYSTEM_PROMPT_PRESETS,
    MEMORY_MODE_PRESETS,
    MODULE_NAME,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    defaultSettings,
} from './constants.js';
import {
    getChatMetadata,
    getExtensionSettings,
    saveMetadata,
    saveSettingsDebounced,
} from './context.js';
import { isPlainObject, normalizeStringArray } from './objects.js';
import { getAllRouteSettingKeys } from './connection-routes.js';
import { normalizeSettings } from './settings-normalizer.js';
import { readOperationMode, repairOperationMode } from './operation-mode.js';

/**
 * The host-facing half of extension state: the settings object and the chat
 * store as the SillyTavern context holds them, plus the defaults reset. The
 * repair passes this module calls are host-free (settings-normalizer.js).
 */

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
    const modeSettingsNormalized = repairOperationMode(settings, { hadUiMode });
    const settingsNormalized = normalizeSettings(settings, { hadMaskUserRoleMode });
    if (modeSettingsNormalized || settingsNormalized) {
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
    return readOperationMode(settings).enabled ? settings : { ...settings, enabled: false };
}

/**
 *
 */
export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Keys a defaults reset never touches: the selected memory/UI/config modes and
 * the Operation Mode gate they project, every Connection Route setting (all
 * four keys of every route, derived from the route catalogue), and debugMode
 * (re-enabled explicitly after the reset loop).
 * @type {Set<string>}
 */
const RESET_PRESERVED_KEYS = new Set([
    'memoryMode',
    'uiMode',
    'configMode',
    'enabled',
    ...getAllRouteSettingKeys(),
    'debugMode',
]);

const PROMPT_PRESET_TABLES = Object.freeze({
    summarizerSystemPromptPreset: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    promptPreset: PROMPT_PRESETS,
    summarizerRepairPromptPreset: SUMMARIZER_REPAIR_PROMPT_PRESETS,
    promotionSystemPromptPreset: PROMOTION_SYSTEM_PROMPT_PRESETS,
    promotionPromptPreset: PROMOTION_PROMPT_PRESETS,
    promotionRepairPromptPreset: PROMOTION_REPAIR_PROMPT_PRESETS,
    auditorSystemPromptPreset: AUDITOR_SYSTEM_PROMPT_PRESETS,
    auditorPromptPreset: AUDITOR_PROMPT_PRESETS,
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
 * Normalize persisted chat metadata in place.
 * @param {SummaryceptionStore} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
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
        mutationEpoch: 0,
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
 * @returns {number}
 */
function normalizeMutationEpoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return 0;
    }
    return Math.max(0, value);
}
