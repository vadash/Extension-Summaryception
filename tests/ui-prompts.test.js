import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    LAYER0_RECALL_PRESETS,
    PROMPT_PRESETS,
    defaultSettings,
} from '../src/foundation/constants.js';
import { bindPromptProfiles } from '../src/entry/ui-prompts.js';
import { getSettings } from '../src/foundation/settings.js';
import { createJQueryHarness, installSummaryContext } from './test-helpers.js';

describe('prompt profile bindings', () => {
    let dom;
    let saveSettingsDebounced;

    beforeEach(() => {
        saveSettingsDebounced = vi.fn();
        installSummaryContext({ settings: { debugMode: false }, saveSettingsDebounced });
        globalThis.document = {};
        dom = createJQueryHarness();
        globalThis.$ = dom.$;
        getSettings();
        saveSettingsDebounced.mockClear();
    });

    afterEach(() => {
        delete globalThis.document;
    });

    it('fills the textarea and persists both settings keys when a valid preset is selected', () => {
        bindPromptProfiles();

        const select = dom.element('#sc_prompt_preset');
        select.val('narrative');
        dom.trigger('change', '#sc_prompt_preset', select);

        const s = getSettings();
        expect(s.promptPreset).toBe('narrative');
        expect(s.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
        expect(dom.element('#sc_summarizer_user_prompt').val()).toBe(PROMPT_PRESETS.narrative);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('snaps an unknown preset value back to the field default without writing settings', () => {
        bindPromptProfiles();

        const select = dom.element('#sc_prompt_preset');
        select.val('bogus-preset');
        dom.trigger('change', '#sc_prompt_preset', select);

        expect(select.val()).toBe('narrative');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        const s = getSettings();
        expect(s.promptPreset).toBe('narrative');
        expect(s.summarizerUserPrompt).toBe(defaultSettings.summarizerUserPrompt);
    });

    it('flips the profile to custom and updates the select when the textarea is edited', () => {
        bindPromptProfiles();

        const textarea = dom.element('#sc_summarizer_user_prompt');
        textarea.val('my custom prompt');
        dom.trigger('input', '#sc_summarizer_user_prompt', textarea);

        const s = getSettings();
        expect(s.summarizerUserPrompt).toBe('my custom prompt');
        expect(s.promptPreset).toBe('custom');
        expect(dom.element('#sc_prompt_preset').val()).toBe('custom');
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('fills the layer0 recall textarea and persists both recall keys from the preset', () => {
        bindPromptProfiles();

        const select = dom.element('#sc_layer0_recall_preset');
        select.val('narrative');
        dom.trigger('change', '#sc_layer0_recall_preset', select);

        const s = getSettings();
        expect(s.layer0RecallPreset).toBe('narrative');
        expect(s.layer0RecallBody).toBe(LAYER0_RECALL_PRESETS.narrative);
        expect(dom.element('#sc_layer0_recall_body').val()).toBe(LAYER0_RECALL_PRESETS.narrative);
    });

    it('flips the layer0 recall profile to custom when its textarea is edited', () => {
        bindPromptProfiles();

        const textarea = dom.element('#sc_layer0_recall_body');
        textarea.val('my recall checklist');
        dom.trigger('input', '#sc_layer0_recall_body', textarea);

        const s = getSettings();
        expect(s.layer0RecallBody).toBe('my recall checklist');
        expect(s.layer0RecallPreset).toBe('custom');
        expect(dom.element('#sc_layer0_recall_preset').val()).toBe('custom');
    });

    it('binds the promotion recall pair the same way', () => {
        bindPromptProfiles();

        const textarea = dom.element('#sc_promotion_recall_body');
        textarea.val('my promotion recall');
        dom.trigger('input', '#sc_promotion_recall_body', textarea);

        const s = getSettings();
        expect(s.promotionRecallBody).toBe('my promotion recall');
        expect(s.promotionRecallPreset).toBe('custom');
        expect(dom.element('#sc_promotion_recall_preset').val()).toBe('custom');
    });
});
