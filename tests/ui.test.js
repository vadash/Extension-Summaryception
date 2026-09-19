import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateContextPreview } from '../src/core/token-budget.js';
import {
    bindDataSettingElements,
    bindSliderSettingPairs,
    readLines,
} from '../src/entry/ui-bind.js';
import {
    initConnectionUI,
    updateAuditorConnectionSubPanels,
    updateAuditorFallbackConnectionSubPanels,
} from '../src/entry/ui-connection.js';
import { getSettings } from '../src/foundation/state.js';
import { buildTriggerGaugeModel } from '../src/entry/ui-view-models.js';
import { createJQueryHarness, installSummaryContext } from './test-helpers.js';

vi.mock('../src/entry/ui.js', async (importOriginal) => ({
    ...(await importOriginal()),
    updateUI: vi.fn(),
}));

describe('context limit and trigger gauge UI models', () => {
    it('builds the context preview estimates from token budgets and defaults', () => {
        expect(
            estimateContextPreview({
                memoryTokenBudget: 10000,
                verbatimTokenBudget: 16000,
                queuedTokenBudget: 32000,
            }),
        ).toEqual({
            rawChatMin: 16000,
            rawChatMax: 48000,
            mainMin: 26000,
            mainMax: 58000,
            l0Typical: 28000,
            l0Max: 36000,
            l1Total: 6840,
        });
    });

    it('builds the queued gauge from the auto work read model and the queued budget', () => {
        expect(
            buildTriggerGaugeModel(
                { queuedTokens: 4321.2, queuedEstimated: true },
                { queuedTokenBudget: 16000 },
            ),
        ).toMatchObject({
            queuedTokens: 4322,
            queuedEstimated: true,
            triggerTokens: 16000,
        });
    });
});

describe('data-attr setting binding engine', () => {
    beforeEach(() => {
        installSummaryContext({ settings: { debugMode: false, stripPatterns: [] } });
    });
    afterEach(() => {
        delete globalThis.document;
    });

    it('reads textarea content as trimmed non-empty lines', () => {
        expect(readLines({ val: () => '  foo\n\n  bar \n   \nbaz' })).toEqual([
            'foo',
            'bar',
            'baz',
        ]);
        expect(readLines({ val: () => '' })).toEqual([]);
    });

    it('binds checkbox settings from data attributes on change and syncs at bind time', () => {
        const dom = createJQueryHarness({
            attributes: {
                '#sc_debug_mode': { type: 'checkbox', 'data-sc-setting': 'debugMode' },
            },
        });
        globalThis.$ = dom.$;

        bindDataSettingElements('#sc_debug_mode', { eventName: 'change' });

        expect(dom.element('#sc_debug_mode').prop('checked')).toBe(false);
        expect(() => dom.trigger('input', '#sc_debug_mode')).toThrow(
            'No handler registered for input',
        );
        dom.element('#sc_debug_mode').prop('checked', true);
        dom.trigger('change', '#sc_debug_mode');
        expect(getSettings().debugMode).toBe(true);
    });

    it('binds lines and plain string settings from their declared data types', () => {
        const dom = createJQueryHarness({
            attributes: {
                '#sc_strip_patterns': {
                    'data-sc-setting': 'stripPatterns',
                    'data-sc-type': 'lines',
                },
                '#sc_custom_memory_position': {
                    'data-sc-setting': 'customMemoryPosition',
                },
            },
        });
        globalThis.$ = dom.$;
        const afterSave = vi.fn();

        bindDataSettingElements('#sc_strip_patterns, #sc_custom_memory_position', {
            eventName: 'change',
            afterSave,
        });

        dom.element('#sc_strip_patterns').val('  foo\n\nbar ');
        dom.trigger('change', '#sc_strip_patterns');
        dom.trigger('change', '#sc_custom_memory_position');
        expect(getSettings().stripPatterns).toEqual(['foo', 'bar']);
        expect(getSettings().customMemoryPosition).toBe('in_prompt');
        expect(afterSave).toHaveBeenCalledTimes(2);
    });

    it('clamps slider writes to SLIDER_LIMITS bounds, not the template attributes', () => {
        const dom = createJQueryHarness({
            attributes: {
                'input[type="range"][data-sc-slider-setting]': {
                    type: 'range',
                    id: 'sc_memory_token_budget',
                    'data-sc-slider-setting': 'memoryTokenBudget',
                    'data-sc-partner-input': '#sc_memory_token_budget_val',
                },
                '#sc_memory_token_budget': {
                    type: 'range',
                    id: 'sc_memory_token_budget',
                    // The stale max is intentional: the template says 16000, but
                    // SLIDER_LIMITS.memoryTokenBudget.MAX is 32000.
                    min: '4000',
                    max: '16000',
                    step: '1000',
                },
                '#sc_memory_token_budget_val': { type: 'text' },
            },
        });
        globalThis.$ = dom.$;
        globalThis.document = {};

        bindSliderSettingPairs();

        dom.element('#sc_memory_token_budget_val').val('24k');
        dom.trigger('change', '#sc_memory_token_budget_val');
        expect(getSettings().memoryTokenBudget).toBe(24000);

        dom.element('#sc_memory_token_budget_val').val('99k');
        dom.trigger('change', '#sc_memory_token_budget_val');
        expect(getSettings().memoryTokenBudget).toBe(32000);
    });

    it('round-trips slider writes when the template attributes match the declared bounds', () => {
        const dom = createJQueryHarness({
            attributes: {
                'input[type="range"][data-sc-slider-setting]': {
                    type: 'range',
                    id: 'sc_memory_token_budget',
                    'data-sc-slider-setting': 'memoryTokenBudget',
                    'data-sc-partner-input': '#sc_memory_token_budget_val',
                },
                '#sc_memory_token_budget': {
                    type: 'range',
                    id: 'sc_memory_token_budget',
                    min: '4000',
                    max: '32000',
                    step: '1000',
                },
                '#sc_memory_token_budget_val': { type: 'text' },
            },
        });
        globalThis.$ = dom.$;
        globalThis.document = {};

        bindSliderSettingPairs();

        dom.element('#sc_memory_token_budget_val').val('24k');
        dom.trigger('change', '#sc_memory_token_budget_val');
        expect(getSettings().memoryTokenBudget).toBe(24000);
        expect(dom.element('#sc_memory_token_budget').val()).toBe(24000);
    });
});

describe('auditor connection routes', () => {
    const AUDITOR_ATTRS = {
        '#summaryception_auditor_connection_source': {
            'data-sc-setting': 'auditorConnectionSource',
        },
        '#summaryception_auditor_connection_profile': {
            'data-sc-setting': 'auditorConnectionProfileId',
        },
        '#summaryception_auditor_fallback_connection_source': {
            'data-sc-setting': 'auditorFallbackConnectionSource',
        },
        '#summaryception_auditor_fallback_connection_profile': {
            'data-sc-setting': 'auditorFallbackConnectionProfileId',
        },
        '#sc_auditor_summarizer_response_length': {
            type: 'number',
            'data-sc-setting': 'auditorSummarizerResponseLength',
            'data-sc-type': 'number',
            'data-sc-fallback': '0',
        },
        '#sc_auditor_fallback_summarizer_response_length': {
            type: 'number',
            'data-sc-setting': 'auditorFallbackSummarizerResponseLength',
            'data-sc-type': 'number',
            'data-sc-fallback': '0',
        },
        '#sc_auditor_narrative_fallback': {
            type: 'checkbox',
            'data-sc-setting': 'auditorNarrativeFallback',
        },
    };

    beforeEach(() => {
        installSummaryContext({});
    });
    afterEach(() => {
        delete globalThis.document;
    });

    it('binds the auditor routes and syncs the inherited defaults at init', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;
        globalThis.document = {};

        initConnectionUI();

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_fallback_section').isVisible()).toBe(false);
        expect(dom.element('#sc_auditor_narrative_fallback_row').isVisible()).toBe(false);

        dom.element('#summaryception_auditor_connection_source').val('profile');
        dom.trigger('change', '#summaryception_auditor_connection_source');
        expect(getSettings().auditorConnectionSource).toBe('profile');

        dom.element('#summaryception_auditor_fallback_connection_source').val('default');
        dom.trigger('change', '#summaryception_auditor_fallback_connection_source');
        expect(getSettings().auditorFallbackConnectionSource).toBe('default');

        dom.element('#sc_auditor_summarizer_response_length').val('400');
        dom.trigger('input', '#sc_auditor_summarizer_response_length');
        expect(getSettings().auditorSummarizerResponseLength).toBe(400);

        dom.element('#sc_auditor_narrative_fallback').prop('checked', true);
        dom.trigger('input', '#sc_auditor_narrative_fallback');
        expect(getSettings().auditorNarrativeFallback).toBe(true);
    });

    it('hides the auditor extras while the Auditor inherits Layer 0', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;

        updateAuditorConnectionSubPanels('inherit');

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_fallback_section').isVisible()).toBe(false);
        expect(dom.element('#sc_auditor_narrative_fallback_row').isVisible()).toBe(false);
    });

    it('shows the auditor rows once separated and the profile panel only for profiles', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;

        updateAuditorConnectionSubPanels('default');

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(true);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(true);
        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_fallback_section').isVisible()).toBe(true);
        expect(dom.element('#sc_auditor_narrative_fallback_row').isVisible()).toBe(true);

        updateAuditorConnectionSubPanels('profile');

        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(true);
    });

    it('hides the Auditor fallback extras while the fallback route is disabled', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;

        updateAuditorFallbackConnectionSubPanels('disabled');

        expect(
            dom.element('#summaryception_auditor_fallback_response_length_row').isVisible(),
        ).toBe(false);
        expect(dom.element('#summaryception_auditor_fallback_timeout_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_fallback_profile_settings').isVisible()).toBe(
            false,
        );

        updateAuditorFallbackConnectionSubPanels('profile');

        expect(
            dom.element('#summaryception_auditor_fallback_response_length_row').isVisible(),
        ).toBe(true);
        expect(dom.element('#summaryception_auditor_fallback_timeout_row').isVisible()).toBe(true);
        expect(dom.element('#summaryception_auditor_fallback_profile_settings').isVisible()).toBe(
            true,
        );
    });
});
