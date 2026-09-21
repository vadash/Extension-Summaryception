import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROMPT_PRESETS, defaultSettings } from '../src/foundation/constants.js';
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
});
