import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    SLIDER_LIMITS,
    UI_MODES,
    applyMemoryModePreset,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    bumpSummaryStoreMutationEpoch,
    collectSnippetSourceIds,
    getChatStore,
    getCurrentSummarizedBoundary,
    getEffectiveSettings,
    getPlayerName,
    getSettings,
    getSummaryStoreMutationEpoch,
    resetSettingsToDefaults,
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
        expect(getSettings()).toBe(first);
        for (const key of ['enabled', 'minSummaryTurns', 'memoryTokenBudget']) {
            expect(Object.hasOwn(first, key)).toBe(true);
        }
    });

    it('backfills missing keys in place onto a raw partial settings object', () => {
        const ctx = installSillyTavernStub({ settings: { enabled: true } });
        const settings = getSettings();
        expect(ctx.extensionSettings.summaryception).toBe(settings);
        expect(Object.hasOwn(settings, 'memoryTokenBudget')).toBe(true);
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
            verbatimTokenBudget: SLIDER_LIMITS.verbatimTokenBudget.MIN,
            queuedTokenBudget: SLIDER_LIMITS.queuedTokenBudget.MAX,
        });
    });
    it('clamps route timeouts above the slider max', () => {
        installSummaryContext({
            settings: {
                requestTimeoutSeconds: 8000,
                mergeRequestTimeoutSeconds: 8000,
                fallbackRequestTimeoutSeconds: 8000,
            },
        });
        expect(getSettings()).toMatchObject({
            requestTimeoutSeconds: SLIDER_LIMITS.requestTimeoutSeconds.MAX,
            mergeRequestTimeoutSeconds: SLIDER_LIMITS.mergeRequestTimeoutSeconds.MAX,
            fallbackRequestTimeoutSeconds: SLIDER_LIMITS.fallbackRequestTimeoutSeconds.MAX,
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
        expect(getSettings().cacheTtlMinutes).toBe(SLIDER_LIMITS.cacheTtlMinutes.MAX);

        installSummaryContext({ settings: {} });
        expect(getSettings().cacheTtlMinutes).toBe(defaultSettings.cacheTtlMinutes);
    });
});

describe('auditor connection settings', () => {
    it('resets invalid auditor connection sources to their defaults', () => {
        installSummaryContext({
            settings: {
                auditorConnectionSource: 'bogus',
                auditorFallbackConnectionSource: 'bogus',
            },
        });
        expect(getSettings()).toMatchObject({
            auditorConnectionSource: defaultSettings.auditorConnectionSource,
            auditorFallbackConnectionSource: defaultSettings.auditorFallbackConnectionSource,
        });

        installSummaryContext({ settings: { auditorConnectionSource: 'default' } });
        expect(getSettings().auditorConnectionSource).toBe('default');
    });

    it('clamps auditor route timeouts to the slider bounds', () => {
        installSummaryContext({
            settings: {
                auditorRequestTimeoutSeconds: 8000,
                auditorFallbackRequestTimeoutSeconds: 5,
            },
        });
        expect(getSettings()).toMatchObject({
            auditorRequestTimeoutSeconds: SLIDER_LIMITS.auditorRequestTimeoutSeconds.MAX,
            auditorFallbackRequestTimeoutSeconds:
                SLIDER_LIMITS.auditorFallbackRequestTimeoutSeconds.MIN,
        });
    });

    it('coerces the narrative fallback toggle to a strict boolean', () => {
        installSummaryContext({ settings: { auditorNarrativeFallback: 'yes' } });
        expect(getSettings().auditorNarrativeFallback).toBe(false);

        installSummaryContext({ settings: { auditorNarrativeFallback: true } });
        expect(getSettings().auditorNarrativeFallback).toBe(true);
    });
});

describe('getEffectiveSettings', () => {
    it('forces enabled:false in OFF mode (the OFF branch disables the effective settings)', () => {
        // normalizeModeSettings overwrites enabled to match uiMode. A raw
        // enabled:true under OFF is therefore unobservable through
        // getSettings(), so this test asserts the effective output only.
        installSummaryContext({ settings: { uiMode: UI_MODES.OFF, enabled: true } });
        const effective = getEffectiveSettings();
        expect(effective.enabled).toBe(false);
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

describe('collectSnippetSourceIds', () => {
    it('flattens provenance across all layers, deduping in first-seen order', () => {
        const layers = [
            [
                { text: 'a', sourceMessageIds: ['m-2', 'm-1'] },
                { text: 'b', sourceMessageIds: ['m-1', 'm-3'] },
            ],
            [{ text: 'c', sourceMessageIds: ['m-3', 'm-4'] }],
            [],
        ];
        expect(collectSnippetSourceIds(layers)).toEqual(['m-2', 'm-1', 'm-3', 'm-4']);
    });

    it('skips non-string and blank ids and dedupes on the raw value', () => {
        const layers = [[{ text: 'a', sourceMessageIds: ['', '   ', 7, null, ' m-1 ', ' m-1 '] }]];
        expect(collectSnippetSourceIds(layers)).toEqual([' m-1 ']);
    });

    it('reads only the requested layer when layerIndex is given', () => {
        const layers = [
            [{ text: 'a', sourceMessageIds: ['m-1'] }],
            [{ text: 'b', sourceMessageIds: ['m-2', 'm-1'] }],
        ];
        expect(collectSnippetSourceIds(layers, { layerIndex: 0 })).toEqual(['m-1']);
        expect(collectSnippetSourceIds(layers, { layerIndex: 1 })).toEqual(['m-2', 'm-1']);
    });

    it('tolerates missing layers and snippets without provenance', () => {
        expect(collectSnippetSourceIds(undefined)).toEqual([]);
        expect(collectSnippetSourceIds([[{ text: 'no ids' }], null], { layerIndex: 1 })).toEqual(
            [],
        );
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

describe('resetSettingsToDefaults', () => {
    function settingsFor(overrides = {}) {
        installSummaryContext({ settings: overrides });
        return getSettings();
    }

    it('preserves mode, connection-route, and route timeout settings', () => {
        const s = settingsFor({
            memoryMode: MEMORY_MODES.PREFIX_CACHE,
            uiMode: UI_MODES.ADVANCED,
            configMode: UI_MODES.ADVANCED,
            connectionSource: 'profile',
            connectionProfileId: 'profile-1',
            requestTimeoutSeconds: 90,
            mergeConnectionProfileId: 'merge-1',
            mergeConnectionSource: 'profile',
            mergeSummarizerResponseLength: 777,
            mergeRequestTimeoutSeconds: 80,
            fallbackConnectionSource: 'default',
            fallbackConnectionProfileId: 'fallback-1',
            fallbackSummarizerResponseLength: 555,
            fallbackRequestTimeoutSeconds: 70,
            auditorConnectionSource: 'profile',
            auditorConnectionProfileId: 'auditor-1',
            auditorSummarizerResponseLength: 333,
            auditorRequestTimeoutSeconds: 130,
            auditorFallbackConnectionSource: 'default',
            auditorFallbackConnectionProfileId: 'auditor-2',
            auditorFallbackSummarizerResponseLength: 444,
            auditorFallbackRequestTimeoutSeconds: 150,
            auditorNarrativeFallback: true,
        });

        resetSettingsToDefaults();

        expect(s).toMatchObject({
            memoryMode: MEMORY_MODES.PREFIX_CACHE,
            uiMode: UI_MODES.ADVANCED,
            configMode: UI_MODES.ADVANCED,
            connectionSource: 'profile',
            connectionProfileId: 'profile-1',
            requestTimeoutSeconds: 90,
            mergeConnectionSource: 'profile',
            mergeConnectionProfileId: 'merge-1',
            mergeSummarizerResponseLength: 777,
            mergeRequestTimeoutSeconds: 80,
            fallbackConnectionSource: 'default',
            fallbackConnectionProfileId: 'fallback-1',
            fallbackSummarizerResponseLength: 555,
            fallbackRequestTimeoutSeconds: 70,
            auditorConnectionSource: 'profile',
            auditorConnectionProfileId: 'auditor-1',
            auditorSummarizerResponseLength: 333,
            auditorRequestTimeoutSeconds: 130,
            auditorFallbackConnectionSource: 'default',
            auditorFallbackConnectionProfileId: 'auditor-2',
            auditorFallbackSummarizerResponseLength: 444,
            auditorFallbackRequestTimeoutSeconds: 150,
            auditorNarrativeFallback: defaultSettings.auditorNarrativeFallback,
        });
    });
    it('resets plain keys to defaults and re-enables debug mode', () => {
        const s = settingsFor();
        s.injectionTemplate = 'edited';
        s.autoPaused = true;
        s.minSummaryTurns = 9;
        s.debugMode = false;

        resetSettingsToDefaults();

        expect(s.injectionTemplate).toBe(defaultSettings.injectionTemplate);
        expect(s.autoPaused).toBe(defaultSettings.autoPaused);
        expect(s.minSummaryTurns).toBe(defaultSettings.minSummaryTurns);
        expect(s.debugMode).toBe(true);
    });

    it('restores retention budgets from the preserved memory mode preset', () => {
        const s = settingsFor({ memoryMode: MEMORY_MODES.PREFIX_CACHE });
        s.verbatimTokenBudget = 1;
        s.queuedTokenBudget = 999999;

        resetSettingsToDefaults();
        expect(s).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.PREFIX_CACHE]);
    });

    it('resets non-custom prompt profiles and keeps custom profiles untouched', () => {
        const s = settingsFor();
        s.promptPreset = 'narrative';
        s.summarizerUserPrompt = 'edited user prompt';
        s.promotionSystemPromptPreset = 'custom';
        s.promotionSystemPrompt = 'kept custom text';

        resetSettingsToDefaults();

        expect(s.promptPreset).toBe(defaultSettings.promptPreset);
        expect(s.summarizerUserPrompt).toBe(defaultSettings.summarizerUserPrompt);
        expect(s.promotionSystemPromptPreset).toBe('custom');
        expect(s.promotionSystemPrompt).toBe('kept custom text');
    });

    it('copies default arrays instead of aliasing them', () => {
        const s = settingsFor();
        s.stripPatterns.push('extra-pattern');

        resetSettingsToDefaults();

        expect(s.stripPatterns).toEqual(defaultSettings.stripPatterns);
        expect(s.stripPatterns).not.toBe(defaultSettings.stripPatterns);
    });
});
