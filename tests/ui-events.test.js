import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createJQueryHarness,
    installBrowserRuntimeStub,
    installSillyTavernStub,
} from './test-helpers.js';
import { MEMORY_MODES, defaultSettings } from '../src/foundation/constants.js';

const mocks = vi.hoisted(() => ({
    updateInjection: vi.fn(),
    updateUI: vi.fn(),
    syncPayloadSchematic: vi.fn(),
}));

const SETTING_SLIDER_SELECTOR = 'input[type="range"][data-sc-slider-setting]';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.document = {};
});

afterEach(() => {
    globalThis.__summaryceptionRestoreDownloads?.();
    delete globalThis.document;
    delete globalThis.confirm;
    delete globalThis.__summaryceptionDownloads;
    delete globalThis.__summaryceptionRestoreDownloads;
});

describe('ui prompt/reset events', () => {
    it('saves simple checkbox settings through shared bindings', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_debug_mode').prop('checked', true);
        ui.trigger('change', '#sc_debug_mode');

        expect(ctx.extensionSettings.summaryception.debugMode).toBe(true);
    });

    it('saves numeric response length through shared bindings', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_response_length').val('256');
        ui.trigger('input', '#sc_summarizer_response_length');

        expect(ctx.extensionSettings.summaryception.summarizerResponseLength).toBe(256);
    });

    it('parses strip patterns through shared bindings', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_strip_patterns').val('  <thinking>  \n\n</thinking>\n  ');
        ui.trigger('change', '#sc_strip_patterns');

        expect(ctx.extensionSettings.summaryception.stripPatterns).toEqual([
            '<thinking>',
            '</thinking>',
        ]);
    });

    it('syncs metadata-bound slider pairs and accepts compact chip values', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness(makeSliderHarnessOptions(['verbatim']));

        ui.element('#sc_verbatim_token_budget').val('12500');
        ui.trigger('input', '#sc_verbatim_token_budget');

        expect(ctx.extensionSettings.summaryception.verbatimTokenBudget).toBe(13000);
        expect(ui.element('#sc_verbatim_token_budget_val').getValue()).toBe('13k');

        ui.element('#sc_verbatim_token_budget_val').val('12k');
        ui.trigger('change', '#sc_verbatim_token_budget_val');

        expect(ctx.extensionSettings.summaryception.verbatimTokenBudget).toBe(12000);
        expect(ui.element('#sc_verbatim_token_budget').getValue()).toBe(12000);
        expect(ui.element('#sc_verbatim_token_budget_val').getValue()).toBe('12k');
        expect(mocks.updateInjection).toHaveBeenCalledTimes(2);
        expect(mocks.syncPayloadSchematic).toHaveBeenCalledTimes(2);
    });

    it('enforces min/max summary-turn constraints through metadata-bound sliders', async () => {
        const settings = structuredClone(defaultSettings);
        settings.minSummaryTurns = 3;
        settings.maxSummaryTurns = 8;
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness(makeSliderHarnessOptions(['minTurns', 'maxTurns']));

        ui.element('#sc_min_summary_turns_val').val('10');
        ui.trigger('change', '#sc_min_summary_turns_val');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            minSummaryTurns: 10,
            maxSummaryTurns: 10,
        });
        expect(ui.element('#sc_max_summary_turns').getValue()).toBe(10);
        expect(ui.element('#sc_max_summary_turns_val').getValue()).toBe('10');
    });

    it('refreshes injection and UI after custom memory depth changes', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_custom_memory_depth').val('99999');
        ui.trigger('change', '#sc_custom_memory_depth');

        expect(ctx.extensionSettings.summaryception.customMemoryDepth).toBe(10000);
        expect(mocks.updateInjection).toHaveBeenCalledOnce();
        expect(mocks.updateUI).toHaveBeenCalledOnce();
    });

    it('switches Layer 0 user-prompt edits to custom so reset preserves them', async () => {
        const settings = structuredClone(defaultSettings);
        settings.memoryMode = MEMORY_MODES.CACHE;
        settings.verbatimTokenBudget = 32000;
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_user_prompt').val('Custom narrative prompt');
        ui.trigger('input', '#sc_summarizer_user_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promptPreset: 'custom',
            summarizerUserPrompt: 'Custom narrative prompt',
        });

        globalThis.confirm = vi.fn(() => true);
        ui.trigger('click', '#sc_reset_defaults');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promptPreset: 'custom',
            summarizerUserPrompt: 'Custom narrative prompt',
            memoryMode: MEMORY_MODES.CACHE,
            verbatimTokenBudget: 32000,
        });
        expect(mocks.updateInjection).toHaveBeenCalledOnce();
        expect(mocks.updateUI).toHaveBeenCalledOnce();
    });

    it('switches Layer 1+ user-prompt edits to custom so reset preserves them', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_promotion_user_prompt').val('Custom promotion prompt');
        ui.trigger('input', '#sc_promotion_user_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promotionPromptPreset: 'custom',
            promotionUserPrompt: 'Custom promotion prompt',
        });

        globalThis.confirm = vi.fn(() => true);
        ui.trigger('click', '#sc_reset_defaults');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promotionPromptPreset: 'custom',
            promotionUserPrompt: 'Custom promotion prompt',
        });
        expect(mocks.updateInjection).toHaveBeenCalledOnce();
        expect(mocks.updateUI).toHaveBeenCalledOnce();
    });

    it('switches Layer 0 system-prompt edits to custom', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_system_prompt').val('Custom system prompt');
        ui.trigger('input', '#sc_summarizer_system_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            summarizerSystemPromptPreset: 'custom',
            summarizerSystemPrompt: 'Custom system prompt',
        });
        expect(ui.element('#sc_summarizer_system_prompt_preset').getValue()).toBe('custom');
    });

    it('switches Layer 1+ system-prompt edits to custom', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_promotion_system_prompt').val('Custom promotion system prompt');
        ui.trigger('input', '#sc_promotion_system_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promotionSystemPromptPreset: 'custom',
            promotionSystemPrompt: 'Custom promotion system prompt',
        });
        expect(ui.element('#sc_promotion_system_prompt_preset').getValue()).toBe('custom');
    });

    it('switches repair prompt edits to custom independently', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_repair_prompt').val('Custom L0 repair prompt');
        ui.trigger('input', '#sc_summarizer_repair_prompt');
        ui.element('#sc_promotion_repair_prompt').val('Custom L1 repair prompt');
        ui.trigger('input', '#sc_promotion_repair_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            summarizerRepairPromptPreset: 'custom',
            summarizerRepairPrompt: 'Custom L0 repair prompt',
            promotionRepairPromptPreset: 'custom',
            promotionRepairPrompt: 'Custom L1 repair prompt',
        });
        expect(ui.element('#sc_summarizer_repair_prompt_preset').getValue()).toBe('custom');
        expect(ui.element('#sc_promotion_repair_prompt_preset').getValue()).toBe('custom');
    });

    it('resets stock prompt fields to defaults independently', async () => {
        const settings = structuredClone(defaultSettings);
        settings.summarizerSystemPrompt = 'Stock-edited L0 system';
        settings.summarizerRepairPrompt = 'Stock-edited L0 repair';
        settings.promotionSystemPrompt = 'Stock-edited system';
        settings.promotionUserPrompt = 'Stock-edited user';
        settings.promotionRepairPrompt = 'Stock-edited repair';
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        globalThis.confirm = vi.fn(() => true);
        ui.trigger('click', '#sc_reset_defaults');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            summarizerSystemPromptPreset: defaultSettings.summarizerSystemPromptPreset,
            summarizerSystemPrompt: defaultSettings.summarizerSystemPrompt,
            summarizerRepairPromptPreset: defaultSettings.summarizerRepairPromptPreset,
            summarizerRepairPrompt: defaultSettings.summarizerRepairPrompt,
            promotionSystemPromptPreset: defaultSettings.promotionSystemPromptPreset,
            promotionPromptPreset: defaultSettings.promotionPromptPreset,
            promotionSystemPrompt: defaultSettings.promotionSystemPrompt,
            promotionUserPrompt: defaultSettings.promotionUserPrompt,
            promotionRepairPromptPreset: defaultSettings.promotionRepairPromptPreset,
            promotionRepairPrompt: defaultSettings.promotionRepairPrompt,
        });
    });

    it('selecting default preset restores that prompt field default', async () => {
        const settings = structuredClone(defaultSettings);
        settings.summarizerRepairPromptPreset = 'custom';
        settings.summarizerRepairPrompt = 'Custom L0 repair prompt';
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_repair_prompt_preset').val('narrative');
        ui.trigger('change', '#sc_summarizer_repair_prompt_preset');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            summarizerRepairPromptPreset: 'narrative',
            summarizerRepairPrompt: defaultSettings.summarizerRepairPrompt,
        });
        expect(ui.element('#sc_summarizer_repair_prompt').getValue()).toBe(
            defaultSettings.summarizerRepairPrompt,
        );
    });

    it('resets Chinese output policy to the enabled default', async () => {
        const settings = structuredClone(defaultSettings);
        settings.stripChineseIdeographs = false;
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        globalThis.confirm = vi.fn(() => true);
        ui.trigger('click', '#sc_reset_defaults');

        expect(ctx.extensionSettings.summaryception.stripChineseIdeographs).toBe(true);
    });
});

async function installUiEventsHarness(harnessOptions = {}) {
    const harness = createJQueryHarness(harnessOptions);
    installBrowserRuntimeStub({ $: harness.$ });
    mockUiEventDependencies();

    const { bindUIEvents } = await import('../src/entry/ui-events.js');
    bindUIEvents();

    return harness;
}

function makeSliderHarnessOptions(names) {
    const sliders = {
        verbatim: sliderFixture({
            id: 'sc_verbatim_token_budget',
            partner: '#sc_verbatim_token_budget_val',
            key: 'verbatimTokenBudget',
            min: '4000',
            max: '64000',
            step: '1000',
        }),
        minTurns: sliderFixture({
            id: 'sc_min_summary_turns',
            partner: '#sc_min_summary_turns_val',
            key: 'minSummaryTurns',
            min: '2',
            max: '10',
            step: '1',
        }),
        maxTurns: sliderFixture({
            id: 'sc_max_summary_turns',
            partner: '#sc_max_summary_turns_val',
            key: 'maxSummaryTurns',
            min: '3',
            max: '20',
            step: '1',
        }),
    };

    const attributes = {};
    const collections = {
        [SETTING_SLIDER_SELECTOR]: names.map((name) => sliders[name].selector),
    };

    for (const name of names) {
        attributes[sliders[name].selector] = sliders[name].attributes;
    }

    return { attributes, collections };
}

function sliderFixture({ id, partner, key, min, max, step }) {
    return {
        selector: `#${id}`,
        attributes: {
            id,
            min,
            max,
            step,
            'data-sc-slider-setting': key,
            'data-sc-partner-input': partner,
        },
    };
}

function mockUiEventDependencies() {
    vi.doMock('../src/core/ghosting.js', () => ({
        ghostMessagesUpTo: vi.fn(),
        unghostAllMessages: vi.fn(),
    }));
    vi.doMock('../src/core/summarizer.js', () => ({
        abortSummarization: vi.fn(),
        getIsSummarizing: vi.fn(() => false),
        hasActiveAbortController: vi.fn(() => false),
        maybeSummarizeTurns: vi.fn(async () => {}),
        resetCatchupDismissed: vi.fn(),
        runCatchup: vi.fn(async () => ({})),
        runSlopBreaker: vi.fn(async () => ({})),
    }));
    vi.doMock('../src/core/slop-breaker.js', () => ({
        getSlopBreakerPlan: vi.fn(() => ({ reason: 'none' })),
    }));
    vi.doMock('../src/core/verbatim-window.js', () => ({
        getLayer0OverflowPlan: vi.fn(async () => ({ reason: 'none' })),
    }));
    vi.doMock('../src/features/injection.js', () => ({
        updateInjection: mocks.updateInjection,
    }));
    vi.doMock('../src/features/persist.js', () => ({
        persistAndRefresh: vi.fn(),
    }));
    vi.doMock('../src/features/memory.js', () => ({
        clearSummaryceptionMemory: vi.fn(),
    }));
    vi.doMock('../src/entry/ui.js', () => ({
        updateUI: mocks.updateUI,
        syncPayloadSchematic: mocks.syncPayloadSchematic,
    }));
    vi.doMock('../src/entry/ui-dialogs.js', () => ({
        clearManualProgressToast: vi.fn(),
        confirmSlopBreaker: vi.fn(async () => false),
        createManualProgressToast: vi.fn(),
        showCatchupOutcome: vi.fn(),
        showSlopBreakerNoop: vi.fn(),
        showSlopBreakerOutcome: vi.fn(),
        updateManualProgressToast: vi.fn(),
    }));
}
