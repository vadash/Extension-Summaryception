import { getSettings, saveSettings } from '../foundation/state.js';

/**
 * @typedef {object} SettingBinding
 * @property {string} key
 * @property {(source: object) => unknown} read
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [beforeSave]
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [afterSave]
 */

/**
 * @typedef {object} DataSettingOptions
 * @property {string} [eventName]
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [beforeSave]
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [afterSave]
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
 * Bind all elements with `data-sc-setting` metadata and initialize their value.
 * @param {string} selector
 * @param {DataSettingOptions} [options]
 * @returns {void}
 */
export function bindDataSettingElements(selector, options = {}) {
    const settings = getSettings();
    $(selector).each(function () {
        const $element = $(this);
        const key = readDataSettingKey($element);
        if (!key) {
            return;
        }
        syncDataSettingElementValue($element, settings, key);
        bindElementSetting($element, {
            eventName: options.eventName || 'input',
            key,
            read: getDataSettingReader($element),
            beforeSave: options.beforeSave,
            afterSave: options.afterSave,
        });
    });
}

/**
 * Sync all data-bound elements from the provided settings object.
 * @param {string} selector
 * @param {ReturnType<typeof getSettings>} [settings]
 * @returns {void}
 */
export function syncDataSettingElements(selector, settings = getSettings()) {
    $(selector).each(function () {
        const $element = $(this);
        const key = readDataSettingKey($element);
        if (key) {
            syncDataSettingElementValue($element, settings, key);
        }
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

function readDataSettingKey($element) {
    return String($element.attr('data-sc-setting') ?? '').trim();
}

function getDataSettingType($element) {
    return String($element.attr('data-sc-type') || 'trimmed-string');
}

function getDataSettingReader($element) {
    switch (getDataSettingType($element)) {
        case 'number':
            return readIntegerOrZero;
        case 'string':
            return readString;
        case 'trimmed-string':
        default:
            return readTrimmedString;
    }
}

function syncDataSettingElementValue($element, settings, key) {
    const fallback = getDataSettingFallback($element);
    $element.val(String(settings[key] || fallback));
}

function getDataSettingFallback($element) {
    const type = getDataSettingType($element);
    const rawFallback = $element.attr('data-sc-fallback');
    if (type === 'number') {
        return Number.parseInt(String(rawFallback ?? '0'), 10) || 0;
    }
    return String(rawFallback ?? '');
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
    beforeSave?.(settings, value, $source);
    saveSettings();
    afterSave?.(settings, value, $source);
}
