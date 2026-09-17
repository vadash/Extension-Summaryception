import {
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    defaultSettings,
} from '../foundation/constants.js';
import { getSettings, saveSettings } from '../foundation/state.js';

// PROMPT_SETTING_KEYS owns the (presetKey, settingKey) pairs. This map adds
// the UI selectors and preset tables, keyed by presetKey.
const PROMPT_FIELD_UI = {
    summarizerSystemPromptPreset: {
        presetSelect: '#sc_summarizer_system_prompt_preset',
        textarea: '#sc_summarizer_system_prompt',
        presets: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    },
    promptPreset: {
        presetSelect: '#sc_prompt_preset',
        textarea: '#sc_summarizer_user_prompt',
        presets: PROMPT_PRESETS,
    },
    summarizerRepairPromptPreset: {
        presetSelect: '#sc_summarizer_repair_prompt_preset',
        textarea: '#sc_summarizer_repair_prompt',
        presets: SUMMARIZER_REPAIR_PROMPT_PRESETS,
    },
    promotionSystemPromptPreset: {
        presetSelect: '#sc_promotion_system_prompt_preset',
        textarea: '#sc_promotion_system_prompt',
        presets: PROMOTION_SYSTEM_PROMPT_PRESETS,
    },
    promotionPromptPreset: {
        presetSelect: '#sc_promotion_prompt_preset',
        textarea: '#sc_promotion_user_prompt',
        presets: PROMOTION_PROMPT_PRESETS,
    },
    promotionRepairPromptPreset: {
        presetSelect: '#sc_promotion_repair_prompt_preset',
        textarea: '#sc_promotion_repair_prompt',
        presets: PROMOTION_REPAIR_PROMPT_PRESETS,
    },
};

const PROMPT_FIELDS = PROMPT_SETTING_KEYS.map(({ presetKey, settingKey }) => ({
    presetKey,
    settingKey,
    ...PROMPT_FIELD_UI[presetKey],
    defaultPreset: defaultSettings[presetKey],
}));

/**
 * @returns {void}
 */
export function bindPromptProfiles() {
    for (const field of PROMPT_FIELDS) {
        bindPromptPresetSelect(field);
        bindPromptTextarea(field);
    }
}

function bindPromptPresetSelect(field) {
    $(document).on('change', field.presetSelect, function () {
        const selected = String($(this).val());
        if (!Object.hasOwn(field.presets, selected)) {
            $(field.presetSelect).val(field.defaultPreset);
            return;
        }

        const s = getSettings();

        s[field.presetKey] = selected;

        if (selected !== 'custom') {
            const presetText = field.presets[selected] || field.presets[field.defaultPreset];
            $(field.textarea).val(presetText);
            s[field.settingKey] = presetText;
        }

        saveSettings();
    });
}

function bindPromptTextarea(field) {
    $(document).on('input change', field.textarea, function () {
        const s = getSettings();
        const currentText = $(this).val();
        s[field.settingKey] = currentText;

        switchPromptFieldToCustom(field, s);
        saveSettings();
    });
}

function switchPromptFieldToCustom(field, settings) {
    if (settings[field.presetKey] === 'custom') {
        return;
    }

    settings[field.presetKey] = 'custom';
    $(field.presetSelect).val('custom');
}
