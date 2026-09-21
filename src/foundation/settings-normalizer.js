import {
    MASK_USER_ROLE_MODES,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    PROMPT_SETTING_KEYS,
    SLIDER_LIMITS,
    defaultSettings,
} from './constants.js';
import { CONNECTION_ROUTES, getRouteTimeoutLimits } from './connection-routes.js';
import { clampInteger, clampToStep } from './numeric.js';

/**
 * The read-time Settings Normalization pass (CONTEXT.md): the one place a
 * stored settings object is repaired to a legal one. It runs on a plain
 * object with no host access, so the settings object is the whole fixture for
 * its tests, and the load path, the reset pass, and the UI's derive-after-edit
 * path all reach it without touching the host.
 */

const PROMPT_PRESET_VALUES = Object.freeze(['narrative', 'continuity', 'custom']);

/**
 * Repair one stored settings object in place, in order: memory placement, role
 * mask, retention and request timeouts, the Continuity toggles, then the
 * prompt profiles. The retention and timeout passes always clamp and never
 * report change, because the load path persisted them unconditionally before
 * this pass existed.
 * @param {ExtensionSettings} settings - Settings object mutated in place.
 * @param {{ hadMaskUserRoleMode: boolean }} stored - Whether the stored object carried the role-mask key at all.
 * @returns {boolean} Whether a setting the caller persists changed.
 */
export function normalizeSettings(settings, { hadMaskUserRoleMode }) {
    const memorySettingsNormalized = normalizeMemorySettings(settings);
    const roleMaskSettingsNormalized = normalizeRoleMaskSettings(settings, hadMaskUserRoleMode);
    normalizeVerbatimWindowSettings(settings);
    normalizeRequestTimeouts(settings);
    const continuitySettingsNormalized = normalizeContinuitySettings(settings);
    const promptSettingsNormalized = normalizePromptSettings(settings);
    return (
        memorySettingsNormalized ||
        roleMaskSettingsNormalized ||
        continuitySettingsNormalized ||
        promptSettingsNormalized
    );
}

/**
 * Normalize memory placement settings in place.
 * @param {ExtensionSettings} settings
 * @returns {boolean} Whether settings were changed.
 */
function normalizeMemorySettings(settings) {
    const settingsRecord = asSettingsRecord(settings);
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
    for (const route of Object.values(CONNECTION_ROUTES)) {
        if (!isSettingValue(route.sourceOptions, settingsRecord[route.sourceKey])) {
            settingsRecord[route.sourceKey] = route.defaultSource;
            changed = true;
        }
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
 * Reach a settings object through a string key. Normalizers driven by the
 * route catalogue read and write keys the catalogue names, so they index
 * dynamically instead of restating each key.
 * @param {ExtensionSettings} settings
 * @returns {Record<string, unknown>}
 */
function asSettingsRecord(settings) {
    return /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (settings));
}

/**
 * Coerce the Continuity toggles to strict booleans; stored garbage reads as
 * off instead of tripping the runner gates.
 * @param {ExtensionSettings} settings
 * @returns {boolean} Whether settings were changed.
 */
function normalizeContinuitySettings(settings) {
    let changed = false;
    for (const key of ['continuityEnabled', 'auditorNarrativeFallback']) {
        const value = settings[key] === true;
        if (settings[key] !== value) {
            settings[key] = value;
            changed = true;
        }
    }
    return changed;
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
 * Clamp each Connection Route's per-attempt request timeout (in seconds) to
 * its declared slider bounds.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeRequestTimeouts(settings) {
    const settingsRecord = asSettingsRecord(settings);
    for (const route of Object.values(CONNECTION_ROUTES)) {
        const { MIN, MAX, STEP } = getRouteTimeoutLimits(route);
        settingsRecord[route.timeoutKey] = clampToStep(
            settingsRecord[route.timeoutKey],
            MIN,
            MAX,
            STEP,
        );
    }
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
