import { getSettings, saveSettings } from '../foundation/state.js';

export const SETTING_SLIDER_SELECTOR = 'input[type="range"][data-sc-slider-setting]';

/**
 * @typedef {object} SettingBinding
 * @property {string} key - Settings key to persist.
 * @property {(source: object) => unknown} read - Reads the value from the source element.
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [beforeSave] - Optional hook before saving the value.
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [afterSave] - Optional hook after saving the value.
 */

/**
 * @typedef {object} DataSettingOptions
 * @property {string} [eventName] - DOM event used to persist the setting.
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [beforeSave] - Optional hook before saving the value.
 * @property {(settings: ReturnType<typeof getSettings>, value: unknown, source: object) => void} [afterSave] - Optional hook after saving the value.
 */

/**
 * @typedef {object} SliderSettingBindingOptions
 * @property {(settings: ReturnType<typeof getSettings>, value: number, source: object, key: string) => void} [beforeSave] - Optional hook before saving the slider value.
 * @property {(settings: ReturnType<typeof getSettings>, value: number, source: object, key: string) => void} [afterSave] - Optional hook after saving the slider value.
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
 * Bind range sliders to paired numeric inputs using data-sc-slider-setting metadata.
 * @param {string} selector
 * @param {SliderSettingBindingOptions} [options]
 * @returns {void}
 */
export function bindSliderSettingPairs(selector = SETTING_SLIDER_SELECTOR, options = {}) {
    for (const binding of collectSliderSettingBindings(selector)) {
        $(document).on('input', binding.sliderSelector, function () {
            writeSliderSetting(binding, $(this), options);
        });

        $(document).on('change blur', binding.partnerSelector, function () {
            writeSliderSetting(binding, $(this), options);
        });

        $(document).on('focus', binding.partnerSelector, function () {
            $(this).val(getSettings()[binding.key]);
        });
    }
}

/**
 * Sync slider pairs from settings using data-sc-slider-setting metadata.
 * @param {string} selector
 * @param {ReturnType<typeof getSettings>} [settings]
 * @returns {void}
 */
export function syncSliderSettingPairs(
    selector = SETTING_SLIDER_SELECTOR,
    settings = getSettings(),
) {
    for (const binding of collectSliderSettingBindings(selector)) {
        syncSliderSettingPair(binding, settings);
    }
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

function collectSliderSettingBindings(selector) {
    const bindings = [];
    $(selector).each(function () {
        const $slider = $(this);
        const key = readSliderSettingKey($slider);
        const partnerSelector = readPartnerInputSelector($slider);
        const sliderSelector = getIdSelector($slider);
        if (!key || !partnerSelector || !sliderSelector) {
            return;
        }
        bindings.push({
            key,
            sliderSelector,
            partnerSelector,
        });
    });
    return bindings;
}

function readSliderSettingKey($element) {
    return String($element.attr('data-sc-slider-setting') ?? '').trim();
}

function readPartnerInputSelector($element) {
    return String($element.attr('data-sc-partner-input') ?? '').trim();
}

function getIdSelector($element) {
    const id = String($element.attr('id') ?? '').trim();
    return id ? `#${id}` : '';
}

function writeSliderSetting(binding, $source, options) {
    const settings = getSettings();
    const $slider = $(binding.sliderSelector);
    const value = normalizeSliderValue($source.val(), $slider);
    settings[binding.key] = value;
    options.beforeSave?.(settings, value, $source, binding.key);
    syncSliderSettingPairs(SETTING_SLIDER_SELECTOR, settings);
    saveSettings();
    options.afterSave?.(settings, value, $source, binding.key);
}

function syncSliderSettingPair(binding, settings) {
    const $slider = $(binding.sliderSelector);
    const value = normalizeSliderValue(settings[binding.key], $slider);
    $slider.val(value);
    $(binding.partnerSelector).val(formatSliderChipValue(value, $slider));
}

/**
 * Normalize a slider value to the paired range input's min, max, and step.
 * @param {unknown} value
 * @param {object} slider jQuery-wrapped range input
 * @returns {number}
 */
function normalizeSliderValue(value, slider) {
    const min = parseSliderAttr(slider, 'min', 0);
    const max = parseSliderAttr(slider, 'max', min);
    const step = parseSliderAttr(slider, 'step', 1);
    const parsed = parseSliderInputValue(value, { min, step });
    const base = Number.isFinite(parsed) ? parsed : min;
    const clamped = Math.min(max, Math.max(min, base));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Math.round(Math.min(max, Math.max(min, snapped)));
}

function parseSliderInputValue(value, { min, step }) {
    const raw = String(value).trim().toLowerCase();
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
        return Number.NaN;
    }
    if (raw.endsWith('k')) {
        return parsed * 1000;
    }
    if (step >= 1000 && parsed > 0 && parsed < min) {
        return parsed * 1000;
    }
    return parsed;
}

function parseSliderAttr(slider, attr, fallback) {
    const parsed = Number.parseFloat(String(slider.attr(attr)));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatSliderChipValue(value, slider) {
    const step = parseSliderAttr(slider, 'step', 1);
    if (step >= 1000 && value % 1000 === 0) {
        return `${value / 1000}k`;
    }
    return String(value);
}

/**
 * Show and enable the role-mask mode control only while masking is enabled.
 * @param {boolean} enabled
 * @returns {void}
 */
export function syncRoleMaskModeControl(enabled) {
    $('#sc_mask_user_role_mode_row').toggle(enabled);
    $('#sc_mask_user_role_mode').prop('disabled', !enabled);
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
