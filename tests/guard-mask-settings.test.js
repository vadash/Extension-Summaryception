import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
    GUARD_MASK_COT_MODES,
    SLIDER_LIMITS,
    defaultSettings,
} from '../src/foundation/constants.js';
import { normalizeSettings } from '../src/foundation/settings-normalizer.js';
import { getSettings } from '../src/foundation/settings.js';
import {
    SETTING_SLIDER_SELECTOR,
    syncDataSettingElements,
    syncGuardMaskCotControl,
    syncSliderSettingPairs,
} from '../src/entry/ui-bind.js';
import { createJQueryHarness, installSummaryContext, makeForegroundGate } from './test-helpers.js';

const SETTINGS_HTML_URL = new URL('../settings.html', import.meta.url);

const GUARD_COT_ATTRS = {
    '#sc_guard_mask': { type: 'checkbox', 'data-sc-setting': 'guardMask' },
    '#sc_guard_mask_cot_mode': { 'data-sc-setting': 'guardMaskCotMode' },
    '#sc_guard_mask_cot_mode_row': {},
    [SETTING_SLIDER_SELECTOR]: {
        type: 'range',
        id: 'sc_guard_mask_cot_count',
        'data-sc-slider-setting': 'guardMaskCotCount',
        'data-sc-partner-input': '#sc_guard_mask_cot_count_val',
    },
    '#sc_guard_mask_cot_count': {
        type: 'range',
        id: 'sc_guard_mask_cot_count',
        min: String(SLIDER_LIMITS.guardMaskCotCount.MIN),
        max: String(SLIDER_LIMITS.guardMaskCotCount.MAX),
        step: String(SLIDER_LIMITS.guardMaskCotCount.STEP),
        'data-sc-slider-setting': 'guardMaskCotCount',
        'data-sc-partner-input': '#sc_guard_mask_cot_count_val',
    },
    '#sc_guard_mask_cot_count_val': {
        type: 'text',
        'data-sc-slider-setting': 'guardMaskCotCount',
        'data-sc-partner-input': '#sc_guard_mask_cot_count',
    },
    '#sc_guard_mask_cot_count_row': {},
};

/**
 * Install the live settings and the harness for the guard controls.
 * @param {object} settings - Stored guard settings for this test.
 * @returns {ReturnType<typeof createJQueryHarness>}
 */
function installGuardDom(settings) {
    installSummaryContext({ settings });
    const dom = createJQueryHarness({ attributes: GUARD_COT_ATTRS });
    globalThis.$ = dom.$;
    globalThis.document = {};
    return dom;
}

/**
 * Bind the settings entry against the installed harness.
 * @returns {Promise<void>}
 */
async function bindGuardSettings() {
    const { bindUIEvents } = await import('../src/entry/ui-events.js');
    bindUIEvents({
        notify: null,
        gate: makeForegroundGate().gate,
        queue: { request: async () => {} },
        manualRunnerDeps: { queue: { isBusy: () => false } },
    });
}

/** @returns {void} */
afterEach(() => {
    delete globalThis.$;
    delete globalThis.document;
});

describe('guard mask Preset CoT settings round-trip', () => {
    it('saves the mode on change and restores it on the next sync', async () => {
        const dom = installGuardDom({
            guardMask: true,
            guardMaskCotMode: GUARD_MASK_COT_MODES.AUTO,
            guardMaskCotCount: 2,
        });
        await bindGuardSettings();

        dom.element('#sc_guard_mask_cot_mode').val(GUARD_MASK_COT_MODES.ON);
        dom.trigger('change', '#sc_guard_mask_cot_mode');
        expect(getSettings().guardMaskCotMode).toBe(GUARD_MASK_COT_MODES.ON);

        dom.element('#sc_guard_mask_cot_mode').val(GUARD_MASK_COT_MODES.OFF);
        syncDataSettingElements('#sc_guard_mask_cot_mode', getSettings());
        expect(dom.element('#sc_guard_mask_cot_mode').val()).toBe(GUARD_MASK_COT_MODES.ON);
    });

    it('saves the count slider on input and restores it on the next sync', async () => {
        const dom = installGuardDom({
            guardMask: true,
            guardMaskCotMode: GUARD_MASK_COT_MODES.ON,
            guardMaskCotCount: 2,
        });
        await bindGuardSettings();

        dom.element('#sc_guard_mask_cot_count').val('4');
        dom.trigger('input', '#sc_guard_mask_cot_count');
        expect(getSettings().guardMaskCotCount).toBe(4);

        dom.element('#sc_guard_mask_cot_count').val('1');
        syncSliderSettingPairs(SETTING_SLIDER_SELECTOR, getSettings());
        expect(dom.element('#sc_guard_mask_cot_count').val()).toBe(4);
    });

    it('hides the CoT rows while the main mask is off and keeps the stored choice', async () => {
        const dom = installGuardDom({
            guardMask: true,
            guardMaskCotMode: GUARD_MASK_COT_MODES.ON,
            guardMaskCotCount: 4,
        });
        await bindGuardSettings();

        dom.element('#sc_guard_mask').prop('checked', false);
        dom.trigger('change', '#sc_guard_mask');

        expect(getSettings().guardMask).toBe(false);
        expect(dom.element('#sc_guard_mask_cot_mode_row').isVisible()).toBe(false);
        expect(dom.element('#sc_guard_mask_cot_mode').prop('disabled')).toBe(true);
        expect(dom.element('#sc_guard_mask_cot_count').prop('disabled')).toBe(true);
        expect(getSettings().guardMaskCotMode).toBe(GUARD_MASK_COT_MODES.ON);
        expect(getSettings().guardMaskCotCount).toBe(4);
    });

    it('enables the count slider only in on mode', () => {
        const dom = installGuardDom({ guardMask: true });

        syncGuardMaskCotControl(true, GUARD_MASK_COT_MODES.AUTO);
        expect(dom.element('#sc_guard_mask_cot_mode_row').isVisible()).toBe(true);
        expect(dom.element('#sc_guard_mask_cot_mode').prop('disabled')).toBe(false);
        expect(dom.element('#sc_guard_mask_cot_count_row').isVisible()).toBe(true);
        expect(dom.element('#sc_guard_mask_cot_count').prop('disabled')).toBe(true);

        syncGuardMaskCotControl(true, GUARD_MASK_COT_MODES.ON);
        expect(dom.element('#sc_guard_mask_cot_count').prop('disabled')).toBe(false);
        expect(dom.element('#sc_guard_mask_cot_count_val').prop('disabled')).toBe(false);
    });
});

describe('guard mask Preset CoT markup', () => {
    const html = readFileSync(SETTINGS_HTML_URL, 'utf8');

    it('offers exactly the declared CoT modes', () => {
        const select = /<select id="sc_guard_mask_cot_mode"[\s\S]*?<\/select>/.exec(html)?.[0];
        const options = [...(select?.matchAll(/<option\b[^>]*value="([^"]*)"/g) ?? [])].map(
            (match) => match[1],
        );

        expect(options).toEqual(Object.values(GUARD_MASK_COT_MODES));
    });
});

describe('guard mask Preset CoT normalization', () => {
    /**
     * @param {object} overrides - Stored values under test.
     * @returns {{ settings: object, changed: boolean }}
     */
    function normalize(overrides) {
        const settings = { ...defaultSettings, ...overrides };
        return { settings, changed: normalizeSettings(settings, { hadMaskUserRoleMode: true }) };
    }

    it('repairs an unknown CoT mode to the auto default', () => {
        const { settings, changed } = normalize({ guardMaskCotMode: 'sometimes' });

        expect(settings.guardMaskCotMode).toBe(GUARD_MASK_COT_MODES.AUTO);
        expect(changed).toBe(true);
    });

    it('keeps a declared CoT mode without a change report', () => {
        const { settings, changed } = normalize({
            guardMaskCotMode: GUARD_MASK_COT_MODES.ON,
            guardMaskCotCount: 3,
        });

        expect(settings.guardMaskCotMode).toBe(GUARD_MASK_COT_MODES.ON);
        expect(settings.guardMaskCotCount).toBe(3);
        expect(changed).toBe(false);
    });

    it('clamps the CoT count into the declared slider bounds', () => {
        expect(normalize({ guardMaskCotCount: 9 }).settings.guardMaskCotCount).toBe(
            SLIDER_LIMITS.guardMaskCotCount.MAX,
        );
        expect(normalize({ guardMaskCotCount: 0 }).settings.guardMaskCotCount).toBe(
            SLIDER_LIMITS.guardMaskCotCount.MIN,
        );
    });
});
