import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJQueryHarness } from './test-helpers.js';

let activeSettings;
let saveSettingsMock;

const CONNECTION_DATA_SETTING_SELECTOR = '#summaryception_connection_settings [data-sc-setting]';

const CONNECTION_DATA_ATTRIBUTES = Object.freeze({
    '#summaryception_ollama_url': {
        'data-sc-setting': 'ollamaUrl',
        'data-sc-type': 'trimmed-string',
        'data-sc-fallback': 'http://localhost:11434',
    },
    '#summaryception_openai_url': {
        'data-sc-setting': 'openaiUrl',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_openai_key': {
        'data-sc-setting': 'openaiKey',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_openai_model': {
        'data-sc-setting': 'openaiModel',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_openai_max_tokens': {
        'data-sc-setting': 'openaiMaxTokens',
        'data-sc-type': 'number',
        'data-sc-fallback': '0',
    },
    '#sc_merge_summarizer_response_length': {
        'data-sc-setting': 'mergeSummarizerResponseLength',
        'data-sc-type': 'number',
        'data-sc-fallback': '0',
    },
    '#summaryception_merge_ollama_url': {
        'data-sc-setting': 'ollamaUrl',
        'data-sc-type': 'trimmed-string',
        'data-sc-fallback': 'http://localhost:11434',
    },
    '#summaryception_merge_openai_url': {
        'data-sc-setting': 'openaiUrl',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_merge_openai_key': {
        'data-sc-setting': 'openaiKey',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_merge_openai_model': {
        'data-sc-setting': 'mergeOpenaiModel',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_merge_openai_max_tokens': {
        'data-sc-setting': 'mergeOpenaiMaxTokens',
        'data-sc-type': 'number',
        'data-sc-fallback': '0',
    },
    '#sc_fallback_summarizer_response_length': {
        'data-sc-setting': 'fallbackSummarizerResponseLength',
        'data-sc-type': 'number',
        'data-sc-fallback': '0',
    },
    '#summaryception_fallback_ollama_url': {
        'data-sc-setting': 'ollamaUrl',
        'data-sc-type': 'trimmed-string',
        'data-sc-fallback': 'http://localhost:11434',
    },
    '#summaryception_fallback_openai_url': {
        'data-sc-setting': 'openaiUrl',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_fallback_openai_key': {
        'data-sc-setting': 'openaiKey',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_fallback_openai_model': {
        'data-sc-setting': 'fallbackOpenaiModel',
        'data-sc-type': 'trimmed-string',
    },
    '#summaryception_fallback_openai_max_tokens': {
        'data-sc-setting': 'fallbackOpenaiMaxTokens',
        'data-sc-type': 'number',
        'data-sc-fallback': '0',
    },
});

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
    it('initializes data-bound inputs from settings and fallbacks', async () => {
        activeSettings.ollamaUrl = '';
        activeSettings.openaiModel = 'gpt-test';
        activeSettings.mergeOpenaiMaxTokens = 256;
        const { element } = installConnectionJquery();
        const { initConnectionUI } = await import('../src/entry/ui-connection.js');

        initConnectionUI();

        expect(element('#summaryception_ollama_url').getValue()).toBe('http://localhost:11434');
        expect(element('#summaryception_merge_ollama_url').getValue()).toBe(
            'http://localhost:11434',
        );
        expect(element('#summaryception_openai_model').getValue()).toBe('gpt-test');
        expect(element('#summaryception_merge_openai_max_tokens').getValue()).toBe('256');
    });

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
    const harness = createJQueryHarness();
    globalThis.$ = harness.$;
    return { visibility: harness.visibility };
}

function installConnectionJquery() {
    const harness = createJQueryHarness({
        attributes: CONNECTION_DATA_ATTRIBUTES,
        collections: {
            [CONNECTION_DATA_SETTING_SELECTOR]: Object.keys(CONNECTION_DATA_ATTRIBUTES),
        },
    });
    globalThis.$ = harness.$;
    return harness;
}
