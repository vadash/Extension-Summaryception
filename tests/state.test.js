import { describe, it, expect, beforeEach } from 'vitest';
import { installSillyTavernStub, makeContext, makeMessage } from './test-helpers.js';
import { defaultSettings } from '../src/constants.js';

describe('state.js', () => {
    beforeEach(() => {
        delete globalThis.SillyTavern;
    });

    it('returns a backfilled settings object with every default key present', async () => {
        const { getSettings } = await import('../src/state.js');
        installSillyTavernStub({ settings: {} });
        const s = getSettings();
        expect(s).toBeDefined();
        for (const key of Object.keys(defaultSettings)) {
            expect(Object.hasOwn(s, key)).toBe(true);
        }
    });

    it('does not clobber an explicit user setting (e.g., disabled pause flag)', async () => {
        installSillyTavernStub({ settings: { enabled: false, verbatimTurns: 3 } });
        const { getSettings } = await import('../src/state.js');
        const s = getSettings();
        expect(s.enabled).toBe(false);
        expect(s.verbatimTurns).toBe(3);
        // Non-provided keys fall back to defaults.
        expect(s.turnsPerSummary).toBe(defaultSettings.turnsPerSummary);
    });

    it('initializes the chat store with empty layers and a sentinel summarizedUpTo', async () => {
        installSillyTavernStub();
        const { getChatStore, getSettings } = await import('../src/state.js');
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
        const { getChatStore } = await import('../src/state.js');
        const store = getChatStore();
        expect(store.ghostedIndices).toEqual([]);
    });

    it('returns the configured player name', async () => {
        installSillyTavernStub();
        // Override name1 via a context that returns the right shape.
        const ctx = makeContext({ chat: [], metadata: {}, settings: {} });
        ctx.name1 = 'Lyra';
        globalThis.SillyTavern = { getContext: () => ctx };
        const { getSettings } = await import('../src/state.js');
        getSettings();
        const { getPlayerName } = await import('../src/state.js');
        expect(getPlayerName()).toBe('Lyra');
    });
});
