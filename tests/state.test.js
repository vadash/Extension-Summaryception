import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installSillyTavernStub, makeContext, makeMessage } from './test-helpers.js';
import { PROMPT_PRESETS, defaultSettings } from '../src/foundation/constants.js';

describe('state.js', () => {
    beforeEach(() => {
        delete globalThis.SillyTavern;
    });

    it('returns a backfilled settings object with every default key present', async () => {
        const { getSettings } = await import('../src/foundation/state.js');
        installSillyTavernStub({ settings: {} });
        const s = getSettings();
        expect(s).toBeDefined();
        for (const key of Object.keys(defaultSettings)) {
            expect(Object.hasOwn(s, key)).toBe(true);
        }
    });

    it('does not clobber explicit new user settings', async () => {
        installSillyTavernStub({
            settings: {
                enabled: false,
                minSummaryTurns: 4,
                maxSummaryTurns: 7,
                minSummaryBudget: 8000,
                verbatimTokenBudget: 32000,
            },
        });
        const { getSettings } = await import('../src/foundation/state.js');
        const s = getSettings();
        expect(s.enabled).toBe(false);
        expect(s.minSummaryTurns).toBe(4);
        expect(s.maxSummaryTurns).toBe(7);
        expect(s.minSummaryBudget).toBe(8000);
        expect(s.verbatimTokenBudget).toBe(32000);
    });

    it('migrates an old default prompt preset when settings are loaded', async () => {
        const ctx = installSillyTavernStub({
            settings: {
                summarizerUserPrompt: PROMPT_PRESETS.gamestate,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();
        const { getSettings } = await import('../src/foundation/state.js');
        const s = getSettings();
        expect(s.promptPreset).toBe('narrative');
        expect(s.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('migrates an old custom prompt preset when settings are loaded', async () => {
        const customPrompt = 'Summarize only named locations.';
        const ctx = installSillyTavernStub({
            settings: {
                summarizerUserPrompt: customPrompt,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();
        const { getSettings } = await import('../src/foundation/state.js');
        const s = getSettings();
        expect(s.promptPreset).toBe('custom');
        expect(s.summarizerUserPrompt).toBe(customPrompt);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes dynamic verbatim window settings to valid slider values', async () => {
        installSillyTavernStub({
            settings: {
                minSummaryTurns: 9,
                maxSummaryTurns: 4,
                minSummaryBudget: 6500,
                verbatimTokenBudget: 6500,
            },
        });
        const { getSettings } = await import('../src/foundation/state.js');
        const s = getSettings();
        expect(s.minSummaryTurns).toBe(9);
        expect(s.maxSummaryTurns).toBe(9);
        expect(s.minSummaryBudget).toBe(7000);
        expect(s.verbatimTokenBudget).toBe(7000);
    });

    it('initializes the chat store with empty layers and a sentinel summarizedUpTo', async () => {
        installSillyTavernStub();
        const { getChatStore, getSettings } = await import('../src/foundation/state.js');
        getSettings(); // ensure access path works
        const store = getChatStore();
        expect(store.layers).toEqual([]);
        expect(store.summarizedUpTo).toBe(-1);
        expect(store.ghostedIndices).toEqual([]);
    });

    it('creates ghostedIndices lazily if an older save omits it', async () => {
        // Provide a metadata-shaped context directly.
        const ctx = makeContext({
            chat: [makeMessage()],
            metadata: { summaryception: { layers: [], summarizedUpTo: -1 } },
            settings: {},
        });
        globalThis.SillyTavern = { getContext: () => ctx };
        const { getChatStore } = await import('../src/foundation/state.js');
        const store = getChatStore();
        expect(store.ghostedIndices).toEqual([]);
    });

    it('normalizes a missing chat store', async () => {
        const ctx = installSillyTavernStub({ metadata: {} });
        const { getChatStore } = await import('../src/foundation/state.js');
        const store = getChatStore();
        expect(ctx.chatMetadata.summaryception).toBe(store);
        expect(store).toMatchObject({
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        });
    });

    it('normalizes non-array layers and drops malformed snippets', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [
                        [{ text: 'kept', turnRange: [0, 2] }, { text: 42 }, null, ['bad']],
                        'bad-layer',
                    ],
                    summarizedUpTo: 2,
                    ghostedIndices: [],
                },
            },
        });
        const { getChatStore } = await import('../src/foundation/state.js');
        expect(getChatStore().layers).toEqual([[{ text: 'kept', turnRange: [0, 2] }], []]);
    });

    it('normalizes non-array layers to an empty layer list', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: { 0: [{ text: 'bad' }] },
                    summarizedUpTo: 0,
                    ghostedIndices: [],
                },
            },
        });
        const { getChatStore } = await import('../src/foundation/state.js');
        expect(getChatStore().layers).toEqual([]);
    });

    it('normalizes bad summarizedUpTo values to the sentinel', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [],
                    summarizedUpTo: Number.POSITIVE_INFINITY,
                    ghostedIndices: [],
                },
            },
        });
        const { getChatStore } = await import('../src/foundation/state.js');
        expect(getChatStore().summarizedUpTo).toBe(-1);
    });

    it('normalizes duplicate and string ghost indices', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [],
                    summarizedUpTo: -1,
                    ghostedIndices: [0, '1', 1, -1, 'bad', 2.5, 3],
                },
            },
        });
        const { getChatStore } = await import('../src/foundation/state.js');
        expect(getChatStore().ghostedIndices).toEqual([0, 1, 3]);
    });

    it('calculates summarized coverage only through contiguous Layer 0 ranges', async () => {
        const { calculateContiguousSummarizedUpTo } = await import('../src/foundation/state.js');
        const store = {
            layers: [
                [
                    { text: 'later', turnRange: [6, 8] },
                    { text: 'first', turnRange: [0, 2] },
                    { text: 'second', turnRange: [3, 5] },
                    { text: 'gap', turnRange: [10, 11] },
                ],
            ],
            summarizedUpTo: 11,
            ghostedIndices: [],
        };
        expect(calculateContiguousSummarizedUpTo(store)).toBe(8);
    });

    it('returns the configured player name', async () => {
        installSillyTavernStub();
        // Override name1 via a context that returns the right shape.
        const ctx = makeContext({ chat: [], metadata: {}, settings: {} });
        ctx.name1 = 'Lyra';
        globalThis.SillyTavern = { getContext: () => ctx };
        const { getSettings } = await import('../src/foundation/state.js');
        getSettings();
        const { getPlayerName } = await import('../src/foundation/state.js');
        expect(getPlayerName()).toBe('Lyra');
    });
});
