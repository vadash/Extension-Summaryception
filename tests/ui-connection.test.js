import { beforeEach, describe, expect, it, vi } from 'vitest';

let activeSettings;
let saveSettingsMock;

beforeEach(() => {
    vi.resetModules();
    activeSettings = {
        connectionSource: 'default',
        connectionProfileId: '',
        mergeConnectionSource: 'inherit',
        mergeConnectionProfileId: '',
        fallbackConnectionSource: 'disabled',
        fallbackConnectionProfileId: '',
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: '',
        ollamaModelsCache: [],
        openaiUrl: '',
        openaiKey: '',
        openaiModel: '',
        openaiMaxTokens: 0,
        mergeOllamaModel: '',
        mergeOpenaiModel: '',
        mergeOpenaiMaxTokens: 0,
        mergeSummarizerResponseLength: 0,
        fallbackOllamaModel: '',
        fallbackOpenaiModel: '',
        fallbackOpenaiMaxTokens: 0,
        fallbackSummarizerResponseLength: 0,
    };
    saveSettingsMock = vi.fn();
    globalThis.summaryceptionFoundationMocks.context.getRequestHeaders.mockImplementation(
        () => ({}),
    );
    globalThis.summaryceptionFoundationMocks.logger.error.mockImplementation(() => {});
    globalThis.summaryceptionFoundationMocks.logger.warn.mockImplementation(() => {});
    vi.doMock('../src/foundation/state.js', () => ({
        getSettings: () => activeSettings,
        saveSettings: saveSettingsMock,
    }));
    vi.doMock('../src/core/connectionutil.js', () => ({
        fetchOllamaModels: vi.fn(),
        testSummarizerConnection: vi.fn(),
        populateProfileDropdown: vi.fn(() => true),
    }));
});

describe('connection sub-panel visibility', () => {
    it('shows only the selected primary connection panel', async () => {
        const { visibility } = installPanelJquery();
        const { updateConnectionSubPanels } = await import('../src/entry/ui-connection.js');

        updateConnectionSubPanels('ollama');

        expect(visibility.get('summaryception_profile_settings')).toBe(false);
        expect(visibility.get('summaryception_ollama_settings')).toBe(true);
        expect(visibility.get('summaryception_openai_settings')).toBe(false);
    });

    it('toggles merge response length for default/profile sources only', async () => {
        const { visibility } = installPanelJquery();
        const { updateMergeConnectionSubPanels } = await import('../src/entry/ui-connection.js');

        updateMergeConnectionSubPanels('profile');
        expect(visibility.get('summaryception_merge_profile_settings')).toBe(true);
        expect(visibility.get('summaryception_merge_ollama_settings')).toBe(false);
        expect(visibility.get('summaryception_merge_openai_settings')).toBe(false);
        expect(visibility.get('summaryception_merge_response_length_row')).toBe(true);

        updateMergeConnectionSubPanels('openai');
        expect(visibility.get('summaryception_merge_profile_settings')).toBe(false);
        expect(visibility.get('summaryception_merge_ollama_settings')).toBe(false);
        expect(visibility.get('summaryception_merge_openai_settings')).toBe(true);
        expect(visibility.get('summaryception_merge_response_length_row')).toBe(false);
    });

    it('keeps fallback response length hidden for disabled sources', async () => {
        const { visibility } = installPanelJquery();
        const { updateFallbackConnectionSubPanels } = await import('../src/entry/ui-connection.js');

        updateFallbackConnectionSubPanels('default');
        expect(visibility.get('summaryception_fallback_profile_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_ollama_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_openai_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_response_length_row')).toBe(true);

        updateFallbackConnectionSubPanels('disabled');
        expect(visibility.get('summaryception_fallback_profile_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_ollama_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_openai_settings')).toBe(false);
        expect(visibility.get('summaryception_fallback_response_length_row')).toBe(false);
    });
});

describe('connection setting bindings', () => {
    it('saves source changes and refreshes the selected route panel', async () => {
        const { element, trigger, visibility } = installConnectionJquery();
        const { initConnectionUI } = await import('../src/entry/ui-connection.js');

        initConnectionUI();
        element('#summaryception_connection_source').val('ollama');
        trigger('change', '#summaryception_connection_source');

        expect(activeSettings.connectionSource).toBe('ollama');
        expect(saveSettingsMock).toHaveBeenCalledOnce();
        expect(visibility.get('summaryception_profile_settings')).toBe(false);
        expect(visibility.get('summaryception_ollama_settings')).toBe(true);
        expect(visibility.get('summaryception_openai_settings')).toBe(false);
    });

    it('trims shared connection strings before saving and mirrors other matching controls', async () => {
        const { element, trigger } = installConnectionJquery();
        const { initConnectionUI } = await import('../src/entry/ui-connection.js');

        initConnectionUI();
        element('#summaryception_merge_openai_url').val('  https://api.example.test/v1  ');
        trigger('input', '#summaryception_merge_openai_url');

        expect(activeSettings.openaiUrl).toBe('https://api.example.test/v1');
        expect(element('#summaryception_openai_url').getValue()).toBe(
            'https://api.example.test/v1',
        );
        expect(element('#summaryception_fallback_openai_url').getValue()).toBe(
            'https://api.example.test/v1',
        );
    });

    it('parses invalid numeric connection inputs as zero', async () => {
        const { element, trigger } = installConnectionJquery();
        const { initConnectionUI } = await import('../src/entry/ui-connection.js');

        initConnectionUI();
        element('#summaryception_fallback_openai_max_tokens').val('not-a-number');
        trigger('input', '#summaryception_fallback_openai_max_tokens');

        expect(activeSettings.fallbackOpenaiMaxTokens).toBe(0);
        expect(saveSettingsMock).toHaveBeenCalledOnce();
    });
});

function installPanelJquery() {
    const visibility = new Map();

    function wrap(ids) {
        const api = {
            ids,
            length: ids.length,
            add(other) {
                return wrap([...ids, ...other.ids]);
            },
            hide() {
                for (const id of ids) {
                    visibility.set(id, false);
                }
                return api;
            },
            show() {
                for (const id of ids) {
                    visibility.set(id, true);
                }
                return api;
            },
            toggle(value) {
                for (const id of ids) {
                    visibility.set(id, Boolean(value));
                }
                return api;
            },
        };
        return api;
    }

    globalThis.$ = vi.fn((selector) =>
        typeof selector === 'string' && selector.startsWith('#')
            ? wrap([selector.slice(1)])
            : wrap([]),
    );

    return { visibility };
}

function installConnectionJquery() {
    const handlers = new Map();
    const visibility = new Map();
    const elements = new Map();

    function element(selector) {
        if (!elements.has(selector)) {
            elements.set(selector, createConnectionElement(selector, handlers, visibility));
        }
        return elements.get(selector);
    }

    globalThis.$ = vi.fn((selector) => {
        if (typeof selector === 'string' && selector.startsWith('#')) {
            return element(selector);
        }
        return createConnectionElement('', handlers, visibility, []);
    });

    return {
        element,
        trigger(eventName, selector) {
            const handler = handlers.get(`${selector}:${eventName}`);
            if (!handler) {
                throw new Error(`No handler registered for ${eventName} ${selector}`);
            }
            return handler();
        },
        visibility,
    };
}

function createConnectionElement(selector, handlers, visibility, ids = [selector.slice(1)]) {
    const state = { value: '', html: '', visible: true };
    const api = {
        0: { id: ids[0] },
        ids,
        length: ids.length,
        on(eventName, handler) {
            for (const name of String(eventName).split(/\s+/).filter(Boolean)) {
                handlers.set(`${selector}:${name}`, handler);
            }
            return api;
        },
        val(nextValue) {
            if (arguments.length === 0) {
                return state.value;
            }
            state.value = nextValue;
            return api;
        },
        html(nextValue) {
            if (arguments.length === 0) {
                return state.html;
            }
            state.html = nextValue;
            return api;
        },
        append() {
            return api;
        },
        add(other) {
            return createConnectionElement('', handlers, visibility, [...ids, ...other.ids]);
        },
        hide() {
            state.visible = false;
            for (const id of ids) {
                visibility.set(id, false);
            }
            return api;
        },
        show() {
            state.visible = true;
            for (const id of ids) {
                visibility.set(id, true);
            }
            return api;
        },
        toggle(value) {
            state.visible = Boolean(value);
            for (const id of ids) {
                visibility.set(id, Boolean(value));
            }
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
