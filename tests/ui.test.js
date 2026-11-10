import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_MODES, defaultSettings } from '../src/foundation/constants.js';
import { buildInjection } from '../src/core/memory-injection.js';
import { estimateContextPreview } from '../src/core/token-budget.js';
import {
    bindDataSettingElements,
    bindSliderSettingPairs,
    readLines,
    syncGuardMaskMemoryControl,
} from '../src/entry/ui-bind.js';
import { initConnectionUI, syncConnectionPanels } from '../src/entry/ui-connection.js';
import { getSettings } from '../src/foundation/settings.js';
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

    it('images a short span as one partial page and bills its frame', () => {
        const settings = {
            ...defaultSettings,
            memoryTokenBudget: 10000,
            verbatimTokenBudget: 16000,
            queuedTokenBudget: 32000,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'anthropic',
            microficheImageCap: 80,
        };
        const layers = [
            [
                { text: 'The ferry crossed at dawn.' },
                { text: 'The gulls followed the wake.' },
                { text: 'The harbour bell rang once.' },
            ],
        ];
        const injection = buildInjection(layers, settings);
        expect(injection.microfiche).not.toBeNull();
        expect(injection.microfiche.imageTexts).toHaveLength(1);
        expect(injection.microfiche.rawTexts).toEqual([]);
        const frameTokens =
            injection.microfiche.imageTexts.length * injection.microfiche.frameTokenEstimate;
        const noImages = estimateContextPreview(settings, null);
        expect(noImages.mainMin).toBe(26000);
        expect(noImages.mainMax).toBe(58000);
        const preview = estimateContextPreview(settings, injection);
        expect(preview.rawChatMax).toBe(noImages.rawChatMax - frameTokens);
        expect(preview.mainMin).toBe(noImages.mainMin + frameTokens);
        expect(preview.mainMax).toBe(noImages.mainMax);
        const textOnly = buildInjection(layers, { ...settings, memoryMode: MEMORY_MODES.BALANCED });
        expect(textOnly.microfiche).toBeNull();
        expect(estimateContextPreview(settings, textOnly).mainMin).toBe(noImages.mainMin);
    });

    it('debits image tokens from the raw chat bucket the preview reads', () => {
        const settings = {
            ...defaultSettings,
            memoryTokenBudget: 10000,
            verbatimTokenBudget: 16000,
            queuedTokenBudget: 32000,
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'google',
            microficheFrameSize: 512,
            microficheImageCap: 8,
            microficheKeepRaw: 0,
        };
        const injection = buildInjection([[{ text: 'word '.repeat(500) }]], settings);
        expect(injection.microfiche).not.toBeNull();
        expect(injection.microfiche.imageTexts.length).toBe(2);
        const imageTokens =
            injection.microfiche.imageTexts.length * injection.microfiche.frameTokenEstimate;
        const noImages = estimateContextPreview(settings, null);
        const preview = estimateContextPreview(settings, injection);
        expect(preview.rawChatMax).toBe(noImages.rawChatMax - imageTokens);
        expect(preview.mainMax).toBe(noImages.mainMax);
        expect(preview.mainMin).toBe(noImages.mainMin + imageTokens);
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
        dom.element('#sc_custom_memory_position').val('in_prompt');
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

describe('connection route panels', () => {
    const AUDITOR_ATTRS = {
        '#summaryception_auditor_connection_source': {
            'data-sc-setting': 'auditorConnectionSource',
        },
        '#summaryception_auditor_connection_profile': {
            'data-sc-setting': 'auditorConnectionProfileId',
        },
        '#sc_auditor_summarizer_response_length': {
            type: 'number',
            'data-sc-setting': 'auditorSummarizerResponseLength',
            'data-sc-type': 'number',
            'data-sc-fallback': '0',
        },
    };

    beforeEach(() => {
        installSummaryContext({});
    });
    afterEach(() => {
        delete globalThis.document;
    });

    it('binds the auditor route and syncs the inherited defaults at init', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;
        globalThis.document = {};

        initConnectionUI();

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(false);

        dom.element('#summaryception_auditor_connection_source').val('profile');
        dom.trigger('change', '#summaryception_auditor_connection_source');
        expect(getSettings().auditorConnectionSource).toBe('profile');

        dom.element('#sc_auditor_summarizer_response_length').val('400');
        dom.trigger('input', '#sc_auditor_summarizer_response_length');
        expect(getSettings().auditorSummarizerResponseLength).toBe(400);
    });

    it('hides the auditor rows while the Auditor inherits Layer 0', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;

        syncConnectionPanels(getSettings());

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(false);
        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(false);
    });

    it('shows the auditor rows once separated and the profile panel only for profiles', () => {
        const dom = createJQueryHarness({ attributes: AUDITOR_ATTRS });
        globalThis.$ = dom.$;
        const settings = getSettings();

        settings.auditorConnectionSource = 'default';
        syncConnectionPanels(settings);

        expect(dom.element('#summaryception_auditor_response_length_row').isVisible()).toBe(true);
        expect(dom.element('#summaryception_auditor_timeout_row').isVisible()).toBe(true);
        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(false);

        settings.auditorConnectionSource = 'profile';
        syncConnectionPanels(settings);

        expect(dom.element('#summaryception_auditor_profile_settings').isVisible()).toBe(true);
    });
});

describe('Guard Mask gating', () => {
    const MEMORY_MASK_ATTRS = {
        '#sc_guard_mask_memory': { type: 'checkbox', 'data-sc-setting': 'guardMaskMemory' },
    };

    beforeEach(() => {
        installSummaryContext({ settings: { guardMask: false, guardMaskMemory: true } });
    });
    afterEach(() => {
        delete globalThis.document;
    });

    it('disables the memory mask while the main mask is off and keeps its stored value', () => {
        const dom = createJQueryHarness({ attributes: MEMORY_MASK_ATTRS });
        globalThis.$ = dom.$;

        syncGuardMaskMemoryControl(false);

        expect(dom.element('#sc_guard_mask_memory').prop('disabled')).toBe(true);
        expect(getSettings().guardMaskMemory).toBe(true);
    });

    it('enables the memory mask when the main mask is on', () => {
        const dom = createJQueryHarness({ attributes: MEMORY_MASK_ATTRS });
        globalThis.$ = dom.$;

        syncGuardMaskMemoryControl(true);

        expect(dom.element('#sc_guard_mask_memory').prop('disabled')).toBe(false);
    });
});

describe('enabled content rendering', () => {
    it('maps each mode view-model flag onto its panel selectors', async () => {
        const { syncEnabledContent } = await import('../src/entry/ui.js');
        const toggles = {};
        globalThis.$ = (selector) => ({
            toggle(visible) {
                toggles[selector] = visible;
            },
        });

        syncEnabledContent({
            modeLabel: 'Off',
            off: true,
            easyPanel: false,
            advancedPanel: true,
            continuitySection: false,
            stop: false,
            resume: false,
        });

        expect(toggles['#sc_off_content']).toBe(true);
        expect(toggles['#sc_easy_content']).toBe(false);
        expect(toggles['#sc_enabled_content']).toBe(true);
        expect(toggles['#sc_continuity_section']).toBe(false);
        expect(toggles['#sc_stop_summarize, #sc_easy_stop_summarize']).toBe(false);
        expect(toggles['#sc_resume_summarize, #sc_easy_resume_summarize']).toBe(false);
    });
});

describe('status budget bar order', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

    it('renders Memory Block above Verbatim Window above Queued Trigger with the reason under the bars', () => {
        const memory = html.indexOf('id="sc_memory_budget_bar"');
        const verbatim = html.indexOf('id="sc_verbatim_budget_bar"');
        const trigger = html.indexOf('id="sc_trigger_budget_bar"');

        expect(memory).toBeGreaterThan(-1);
        expect(verbatim).toBeGreaterThan(-1);
        expect(trigger).toBeGreaterThan(-1);
        expect(memory).toBeLessThan(verbatim);
        expect(verbatim).toBeLessThan(trigger);
        expect(trigger).toBeLessThan(html.indexOf('id="sc_budget_reason"'));
    });

    it('carries the backlog split in the header and drops the old strips', () => {
        expect(html.indexOf('id="sc_status_backlog"')).toBeGreaterThan(-1);
        expect(html).not.toContain('id="sc_backlog_strip"');
        expect(html).not.toContain('id="sc_status_worker"');
    });
});

describe('budget reason and header backlog rendering', () => {
    const SETTINGS = {
        memoryTokenBudget: 10000,
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
        microficheImageCap: 4,
    };
    const WORK = {
        ready: true,
        backlog: 10,
        verbatimTokens: 16000,
        verbatimEstimated: false,
        verbatimImageTokens: 1000,
        queuedTokens: 3000,
        queuedEstimated: false,
        queuedImageTokens: 3000,
    };

    it('prints the slots-full reason in red and the split in the header', async () => {
        const { renderBudgetStatus, renderStatusOverview } = await import('../src/entry/ui.js');
        const dom = createJQueryHarness();
        globalThis.$ = dom.$;

        await renderBudgetStatus(
            SETTINGS,
            WORK,
            { parts: [] },
            {
                microficheRaw: {
                    effectiveCap: 4,
                    imageTexts: ['p1', 'p2', 'p3', 'p4'],
                    rawTexts: ['t1'],
                    overCap: true,
                    overflowPages: 1,
                },
            },
        );
        await renderStatusOverview('sc_status', 'enabled', {
            settings: SETTINGS,
            modeLabel: 'Advanced',
            work: WORK,
            ghostedCount: 0,
            metrics: { totalSnippets: 0 },
            busy: false,
            sealedFacts: {
                microficheRaw: {
                    effectiveCap: 4,
                    imageTexts: ['p1', 'p2', 'p3', 'p4'],
                    rawTexts: ['t1'],
                    overCap: true,
                    overflowPages: 1,
                },
            },
        });

        expect(dom.element('#sc_memory_budget_total').text()).toBe('0 / 10k');
        expect(dom.element('#sc_verbatim_budget_total').text()).toBe('16k / 20k');
        expect(dom.element('#sc_trigger_budget_total').text()).toBe('3k / 16k');
        expect(dom.element('#sc_budget_reason').text()).toBe(
            'photo slots full 4/4, 1 page waits as text — summarize to free a slot',
        );
        expect(dom.element('#sc_budget_reason').hasClass('sc-context-total-over')).toBe(true);
        expect(dom.element('#sc_status_backlog').text()).toBe('backlog 10 = 4 images + 6 text');
    });

    it('keeps the reason neutral and still splits the header backlog', async () => {
        const { renderBudgetStatus, renderStatusOverview } = await import('../src/entry/ui.js');
        const dom = createJQueryHarness();
        globalThis.$ = dom.$;

        const sealedFacts = {
            microficheRaw: {
                effectiveCap: 4,
                imageTexts: ['p1', 'p2'],
                rawTexts: [],
                overCap: false,
            },
        };
        await renderBudgetStatus(SETTINGS, WORK, { parts: [] }, sealedFacts);
        await renderStatusOverview('sc_status', 'enabled', {
            settings: SETTINGS,
            modeLabel: 'Advanced',
            work: WORK,
            ghostedCount: 0,
            metrics: { totalSnippets: 0 },
            busy: false,
            sealedFacts,
        });

        expect(dom.element('#sc_budget_reason').text()).toBe('imaging 2/4 images');
        expect(dom.element('#sc_budget_reason').hasClass('sc-context-total-over')).toBe(false);
        expect(dom.element('#sc_status_backlog').text()).toBe('backlog 10 = 2 images + 8 text');
    });
});
