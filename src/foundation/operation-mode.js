import { OPERATION_MODES, UI_MODES, defaultSettings } from './constants.js';

/** Values the stored mode radio may hold. */
const UI_MODE_VALUES = Object.values(UI_MODES);
/** Values the Complexity Mode memory may hold. */
const COMPLEXITY_MODE_VALUES = [UI_MODES.EASY, UI_MODES.ADVANCED];

/**
 * @param {ReadonlyArray<string>} values
 * @param {unknown} value
 * @returns {boolean}
 */
function isOneOf(values, value) {
    return values.includes(String(value));
}

/**
 * @param {unknown} value
 * @returns {string} Advanced for the Advanced panel, Easy for anything else.
 */
function readComplexity(value) {
    return value === UI_MODES.ADVANCED ? UI_MODES.ADVANCED : UI_MODES.EASY;
}

/**
 * The two Operation Mode axes in one verdict: On/Off and the Complexity Mode
 * whose panel is visible. `enabled` is the same fact projected into the stored
 * settings gate that runtime modules read, so the invariant is expressed here
 * once instead of at every read site. While Off the visible panel is the
 * remembered Complexity Mode, which is why `complexity` answers that axis
 * rather than echoing the stored radio.
 * @param {ExtensionSettings} settings
 * @returns {{ mode: string, complexity: string, enabled: boolean }}
 */
export function readOperationMode(settings) {
    const on = settings.uiMode !== UI_MODES.OFF;
    return {
        mode: on ? OPERATION_MODES.ON : OPERATION_MODES.OFF,
        complexity: readComplexity(on ? settings.uiMode : settings.configMode),
        enabled: on,
    };
}

/**
 * Show a Complexity Mode panel and turn the extension On.
 * @param {ExtensionSettings} settings
 * @param {string} complexity
 * @returns {void}
 */
export function setComplexity(settings, complexity) {
    const next = readComplexity(complexity);
    settings.uiMode = next;
    settings.configMode = next;
    settings.enabled = true;
}

/**
 * Turn the extension On at the remembered Complexity Mode, or Off through
 * selectOff. The On path restores configMode, so flipping the gate never
 * forgets which panel the user was working in.
 * @param {ExtensionSettings} settings
 * @param {boolean} enabled
 * @returns {void}
 */
export function setEnabled(settings, enabled) {
    if (enabled) {
        settings.uiMode = readComplexity(settings.configMode);
        settings.enabled = true;
        return;
    }
    selectOff(settings);
}

/**
 * Turn the extension Off, keeping the Complexity Mode memory for the next
 * time it turns On.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
export function selectOff(settings) {
    settings.uiMode = UI_MODES.OFF;
    settings.enabled = false;
}

/**
 * Load-time repair of the stored mode trio. The returned flag reports whether
 * the stored gate moved, which is the caller's save trigger; repairs that
 * leave the gate alone are not persisted here, matching the pre-existing
 * normalizer contract.
 * @param {ExtensionSettings} settings
 * @param {{ hadUiMode: boolean }} stored - Whether the raw settings carried a mode.
 * @returns {boolean}
 */
export function repairOperationMode(settings, { hadUiMode }) {
    if (!hadUiMode || !isOneOf(UI_MODE_VALUES, settings.uiMode)) {
        settings.uiMode = settings.enabled === false ? UI_MODES.OFF : defaultSettings.uiMode;
    }

    if (
        !Object.hasOwn(settings, 'configMode') ||
        !isOneOf(COMPLEXITY_MODE_VALUES, settings.configMode)
    ) {
        settings.configMode =
            settings.uiMode === UI_MODES.ADVANCED ? UI_MODES.ADVANCED : defaultSettings.configMode;
    }

    const nextEnabled = settings.uiMode !== UI_MODES.OFF;
    const changed = !hadUiMode || settings.enabled !== nextEnabled;
    settings.enabled = nextEnabled;
    return changed;
}
