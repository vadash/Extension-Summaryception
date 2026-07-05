import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSillyTavernStub } from './test-helpers.js';
import { MEMORY_MODES, defaultSettings } from '../src/foundation/constants.js';

const mocks = vi.hoisted(() => ({
    updateInjection: vi.fn(),
    updateUI: vi.fn(),
    updateCustomPromptSlots: vi.fn(),
    syncPayloadSchematic: vi.fn(),
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.document = {};
});

afterEach(() => {
    delete globalThis.document;
    delete globalThis.confirm;
});

describe('ui prompt/reset events', () => {
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
            lastCustomPrompt: 'Custom narrative prompt',
        });

        globalThis.confirm = vi.fn(() => true);
        ui.trigger('click', '#sc_reset_defaults');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promptPreset: 'custom',
            summarizerUserPrompt: 'Custom narrative prompt',
            lastCustomPrompt: 'Custom narrative prompt',
            memoryMode: MEMORY_MODES.CACHE,
            verbatimTokenBudget: 32000,
        });
        expect(mocks.updateInjection).toHaveBeenCalledOnce();
        expect(mocks.updateUI).toHaveBeenCalledOnce();
    });

    it('switches Layer 0 system-prompt edits to custom', async () => {
        const settings = structuredClone(defaultSettings);
        const ctx = installSillyTavernStub({ settings });
        const ui = await installUiEventsHarness();

        ui.element('#sc_summarizer_system_prompt').val('Custom system prompt');
        ui.trigger('change', '#sc_summarizer_system_prompt');

        expect(ctx.extensionSettings.summaryception).toMatchObject({
            promptPreset: 'custom',
            summarizerSystemPrompt: 'Custom system prompt',
            lastCustomPrompt: defaultSettings.summarizerUserPrompt,
        });
        expect(ui.element('#sc_prompt_preset').getValue()).toBe('custom');
        expect(mocks.updateCustomPromptSlots).toHaveBeenCalledOnce();
    });
});

async function installUiEventsHarness() {
    const harness = createJQueryHarness();
    installBrowserRuntimeStub({ $: harness.$ });
    mockUiEventDependencies();

    const { bindUIEvents } = await import('../src/entry/ui-events.js');
    bindUIEvents();

    return harness;
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
        updateCustomPromptSlots: mocks.updateCustomPromptSlots,
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

function createJQueryHarness() {
    const handlers = [];
    const elements = new Map();

    const element = (selector) => {
        if (!elements.has(selector)) {
            elements.set(selector, createJQueryElement());
        }
        return elements.get(selector);
    };

    const documentWrapper = {
        on(eventName, selector, handler) {
            handlers.push({ eventName, selector, handler });
            return documentWrapper;
        },
    };

    const $ = vi.fn((target) => {
        if (target === globalThis.document) {
            return documentWrapper;
        }
        if (typeof target === 'string') {
            return element(target);
        }
        return target;
    });

    return {
        $,
        element,
        trigger(eventName, selector, target = element(selector)) {
            const entry = handlers.find(
                (handler) => handler.eventName === eventName && handler.selector === selector,
            );
            if (!entry) {
                throw new Error(`No handler registered for ${eventName} ${selector}`);
            }
            return entry.handler.call(target, { type: eventName });
        },
    };
}

function createJQueryElement() {
    const state = { value: '', props: {}, visible: true };
    const api = {
        val(nextValue) {
            if (arguments.length === 0) {
                return state.value;
            }
            state.value = nextValue;
            return api;
        },
        prop(name, nextValue) {
            if (arguments.length === 1) {
                return state.props[name];
            }
            state.props[name] = nextValue;
            return api;
        },
        show() {
            state.visible = true;
            return api;
        },
        hide() {
            state.visible = false;
            return api;
        },
        getValue() {
            return state.value;
        },
        isVisible() {
            return state.visible;
        },
    };
    return api;
}
