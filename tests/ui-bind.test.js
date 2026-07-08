import { afterEach, describe, expect, it } from 'vitest';
import { createJQueryHarness } from './test-helpers.js';
import { SETTING_SLIDER_SELECTOR, syncSliderSettingPairs } from '../src/entry/ui-bind.js';

describe('slider setting bindings', () => {
    afterEach(() => {
        delete globalThis.$;
    });

    it('applies dynamic slider max settings during initial sync', () => {
        const ui = createJQueryHarness({
            attributes: {
                '#sc_min_summary_budget': {
                    id: 'sc_min_summary_budget',
                    min: '2000',
                    max: '32000',
                    step: '1000',
                    'data-sc-slider-setting': 'minSummaryBudget',
                    'data-sc-partner-input': '#sc_min_summary_budget_val',
                    'data-sc-slider-max-setting': 'maxL0SourceTokens',
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

        expect(ui.element('#sc_min_summary_budget').attr('max')).toBe('16000');
        expect(ui.element('#sc_min_summary_budget').getValue()).toBe(8000);
        expect(ui.element('#sc_min_summary_budget_val').getValue()).toBe('8k');
    });
});
