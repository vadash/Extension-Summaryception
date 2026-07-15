import { afterEach, describe, expect, it } from 'vitest';
import { createJQueryHarness } from './test-helpers.js';
import {
    SETTING_SLIDER_SELECTOR,
    syncRoleMaskModeControl,
    syncSliderSettingPairs,
} from '../src/entry/ui-bind.js';

describe('slider setting bindings', () => {
    afterEach(() => {
        delete globalThis.$;
    });

    it('keeps the Batch Trigger slider maximum fixed during initial sync', () => {
        const ui = createJQueryHarness({
            attributes: {
                '#sc_min_summary_budget': {
                    id: 'sc_min_summary_budget',
                    min: '4000',
                    max: '32000',
                    step: '1000',
                    'data-sc-slider-setting': 'minSummaryBudget',
                    'data-sc-partner-input': '#sc_min_summary_budget_val',
                },
            },
            collections: {
                [SETTING_SLIDER_SELECTOR]: ['#sc_min_summary_budget'],
            },
        });
        globalThis.$ = ui.$;

        syncSliderSettingPairs(SETTING_SLIDER_SELECTOR, {
            maxL0SourceTokens: 16000,
            minSummaryBudget: 8000,
        });

        expect(ui.element('#sc_min_summary_budget').attr('max')).toBe('32000');
        expect(ui.element('#sc_min_summary_budget').getValue()).toBe(8000);
        expect(ui.element('#sc_min_summary_budget_val').getValue()).toBe('8k');
    });

    it('shows and enables the role-mask mode only while masking is enabled', () => {
        const ui = createJQueryHarness();
        globalThis.$ = ui.$;

        syncRoleMaskModeControl(true);
        expect(ui.element('#sc_mask_user_role_mode_row').isVisible()).toBe(true);
        expect(ui.element('#sc_mask_user_role_mode').prop('disabled')).toBe(false);

        syncRoleMaskModeControl(false);
        expect(ui.element('#sc_mask_user_role_mode_row').isVisible()).toBe(false);
        expect(ui.element('#sc_mask_user_role_mode').prop('disabled')).toBe(true);
    });
});
