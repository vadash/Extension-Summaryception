import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    globalThis.summaryceptionFoundationMocks.context.getRequestHeaders.mockImplementation(
        () => ({}),
    );
    globalThis.summaryceptionFoundationMocks.logger.error.mockImplementation(() => {});
    globalThis.summaryceptionFoundationMocks.logger.warn.mockImplementation(() => {});
    vi.doMock('../src/foundation/state.js', () => ({
        getSettings: () => ({}),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../src/core/connectionutil.js', () => ({
        fetchOllamaModels: vi.fn(),
        testSummarizerConnection: vi.fn(),
        populateProfileDropdown: vi.fn(),
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
