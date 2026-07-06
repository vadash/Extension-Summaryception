import { getSettings, saveSettings } from '../foundation/state.js';

/**
 * @typedef {object} SettingBinding
 * @property {string} key
 * @property {(source: object) => unknown} read
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown) => void} [beforeSave]
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown) => void} [afterSave]
 */

/**
 * Bind a delegated document event that persists one settings value.
 * @param {SettingBinding & { eventName: string, selector: string }} binding
 * @returns {void}
 */
export function bindDocumentSetting(binding) {
    $(document).on(binding.eventName, binding.selector, function () {
        writeSetting(binding, $(this));
    });
}

/**
 * Bind an already-selected element event that persists one settings value.
 * @param {object} $element jQuery-wrapped element
 * @param {SettingBinding & { eventName: string }} binding
 * @returns {void}
 */
export function bindElementSetting($element, binding) {
    $element.on(binding.eventName, () => {
        writeSetting(binding, $element);
    });
}

/**
 * Read a checkbox as a boolean.
 * @param {object} $element jQuery-wrapped element
 * @returns {boolean}
 */
export function readChecked($element) {
    return Boolean($element.prop('checked'));
}

/**
 * Read an input value as a string.
 * @param {object} $element jQuery-wrapped element
 * @returns {string}
 */
export function readString($element) {
    return String($element.val() ?? '');
}

/**
 * Read a trimmed input value as a string.
 * @param {object} $element jQuery-wrapped element
 * @returns {string}
 */
export function readTrimmedString($element) {
    return readString($element).trim();
}

/**
 * Read a base-10 integer input, falling back to zero.
 * @param {object} $element jQuery-wrapped element
 * @returns {number}
 */
export function readIntegerOrZero($element) {
    return Number.parseInt(readString($element), 10) || 0;
}

/**
 * @param {SettingBinding} binding
 * @param {object} $source jQuery-wrapped source element
 * @returns {void}
 */
function writeSetting(binding, $source) {
    const { key, read, beforeSave, afterSave } = binding;
    const settings = getSettings();
    const value = read($source);
    settings[key] = value;
    beforeSave?.(settings, value);
    saveSettings();
    afterSave?.(settings, value);
}
