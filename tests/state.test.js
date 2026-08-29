import { describe, expect, it } from 'vitest';

import {
    CACHE_TTL,
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    UI_MODES,
    applyMemoryModePreset,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    getCurrentSummarizedBoundary,
    getEffectiveSettings,
    getPlayerName,
    getSettings,
    getSummaryStoreMutationEpoch,
} from '../src/foundation/state.js';
import {
    installSummaryContext,
    installSillyTavernStub,
    makeMessages,
    makeSummaryStore,
} from './test-helpers.js';

describe('getSettings', () => {
    it('returns a settings object and reuses the same reference on subsequent calls', () => {
        const first = getSettings();
        expect(typeof first).toBe('object');
        // The module stores rather than re-clones an existing settings object.
        expect(getSettings()).toBe(first);
        // A handful of known default keys are present.
        for (const key of ['enabled', 'minSummaryTurns', 'memoryTokenBudget']) {
            expect(Object.hasOwn(first, key)).toBe(true);
        }
    });

    it('backfills missing keys in place onto a raw partial settings object', () => {
        const ctx = installSillyTavernStub({ settings: { enabled: true } });
        const settings = getSettings();
        // The stored reference is the returned reference.
        expect(ctx.extensionSettings.summaryception).toBe(settings);
        // It gained default keys it did not have before…
        expect(Object.hasOwn(settings, 'memoryTokenBudget')).toBe(true);
        // …while the originally-provided key survived unchanged.
        expect(settings.enabled).toBe(true);
    });

    it('remaps persisted append-only mode to prefix_cache and resets invalid modes', () => {
        installSummaryContext({
            settings: { memoryMode: 'append_only' },
        });
        expect(getSettings().memoryMode).toBe(MEMORY_MODES.PREFIX_CACHE);

        installSummaryContext({ settings: { memoryMode: 'not-a-mode' } });
        expect(getSettings().memoryMode).toBe(MEMORY_MODES.BALANCED);
    });
});

describe('memory mode budgets', () => {
    it('defaults and clamps independent recent and queued budgets', () => {
        installSummaryContext({
            settings: { verbatimTokenBudget: 999, queuedTokenBudget: 999999 },
        });
        expect(getSettings()).toMatchObject({
            verbatimTokenBudget: 4000,
            queuedTokenBudget: 64000,
        });
    });

    it('applies presets only on real mode transitions', () => {
        const settings = { ...defaultSettings, memoryMode: MEMORY_MODES.BALANCED };
        expect(applyMemoryModePreset(settings, MEMORY_MODES.BALANCED)).toBe(false);
        expect(applyMemoryModePreset(settings, MEMORY_MODES.PREFIX_CACHE)).toBe(true);
        expect(settings).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.PREFIX_CACHE]);
        expect(applyMemoryModePreset(settings, 'invalid')).toBe(false);
    });

    it('defaults and clamps the provider cache TTL', () => {
        installSummaryContext({ settings: { cacheTtlMinutes: 9999 } });
        expect(getSettings().cacheTtlMinutes).toBe(CACHE_TTL.MAX_MINUTES);

        installSummaryContext({ settings: {} });
        expect(getSettings().cacheTtlMinutes).toBe(CACHE_TTL.DEFAULT_MINUTES);
    });
});

describe('getEffectiveSettings', () => {
    it('forces enabled:false in OFF mode (the OFF branch disables the effective settings)', () => {
        // The settings normalizer enforces the invariant enabled === (uiMode !== 'off'),
        // so OFF deterministically yields disabled effective settings. We assert
        // the OFF-branch output directly: the plan's "raw stays enabled:true" half
        // is not reflectable through getSettings() because normalizeModeSettings
        // overwrites enabled to match the mode; drift noted, contract class
        // (branching) preserved.
        installSummaryContext({ settings: { uiMode: UI_MODES.OFF, enabled: true } });
        const effective = getEffectiveSettings();
        expect(effective.enabled).toBe(false);
        // Calling again stays OFF deterministically.
        expect(getEffectiveSettings().enabled).toBe(false);
    });

    it('returns the same settings reference in ADVANCED mode', () => {
        installSummaryContext({ settings: { uiMode: UI_MODES.ADVANCED } });
        expect(getEffectiveSettings()).toBe(getSettings());
    });
});

describe('getChatStore', () => {
    it('creates a normalized default store on a fresh context', () => {
        const store = getChatStore();
        expect(store).toMatchObject({ layers: [], ghostedMessageIds: [], mutationEpoch: 0 });
    });

    it('normalizes UUID arrays and rejects source-less snippets', () => {
        installSummaryContext({
            metadata: {
                summaryception: {
                    layers: [
                        [
                            { text: 'valid', sourceMessageIds: ['a', '', 'a', 'b'] },
                            { text: 'source-less' },
                        ],
                    ],
                    ghostedMessageIds: ['b', '', 'b', 'a'],
                    mutationEpoch: NaN,
                },
            },
        });

        const store = getChatStore();
        expect(store.layers).toEqual([[{ text: 'valid', sourceMessageIds: ['a', 'b'] }]]);
        expect(store.ghostedMessageIds).toEqual(['b', 'a']);
        expect(store.mutationEpoch).toBe(0);
    });
});

describe('summary store mutation epoch', () => {
    it('counts up from a normalized baseline on each bump', () => {
        const store = getChatStore();
        expect(bumpSummaryStoreMutationEpoch(store)).toBe(1);
        expect(store.mutationEpoch).toBe(1);
        expect(bumpSummaryStoreMutationEpoch(store)).toBe(2);
    });

    it('normalizes a bad epoch value to 0 without throwing', () => {
        expect(getSummaryStoreMutationEpoch({ mutationEpoch: 'bad' })).toBe(0);
        expect(getSummaryStoreMutationEpoch(undefined)).toBe(0);
    });
});

describe('getCurrentSummarizedBoundary', () => {
    it('returns -1 when no Layer 0 source ID resolves', () => {
        expect(getCurrentSummarizedBoundary(makeMessages(2), makeSummaryStore())).toBe(-1);
    });

    it('tracks surviving source IDs after a live message deletion shifts indices', () => {
        const chat = makeMessages(5);
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['message-1', 'message-4'] }]],
        });

        expect(getCurrentSummarizedBoundary(chat, store)).toBe(4);
        chat.splice(2, 1);
        expect(getCurrentSummarizedBoundary(chat, store)).toBe(3);
    });
});

describe('getPlayerName', () => {
    it('returns name1 from the installed context', () => {
        expect(getPlayerName()).toBe('Player1');
    });

    it('falls back to "User" when name1 is absent', () => {
        delete globalThis.SillyTavern.getContext().name1;
        expect(getPlayerName()).toBe('User');
    });
});
