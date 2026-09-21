import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    UI_MODES,
    applyMemoryModePreset,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    getEffectiveSettings,
    getSettings,
    getSummaryStoreMutationEpoch,
    resetSettingsToDefaults,
} from '../src/foundation/state.js';
import { CONNECTION_ROUTES } from '../src/foundation/connection-routes.js';
import { installSummaryContext, installSillyTavernStub } from './test-helpers.js';

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
});

describe('memory mode budgets', () => {
    it('applies presets only on real mode transitions', () => {
        const settings = { ...defaultSettings, memoryMode: MEMORY_MODES.BALANCED };
        expect(applyMemoryModePreset(settings, MEMORY_MODES.BALANCED)).toBe(false);
        expect(applyMemoryModePreset(settings, MEMORY_MODES.PREFIX_CACHE)).toBe(true);
        expect(settings).toMatchObject(MEMORY_MODE_PRESETS[MEMORY_MODES.PREFIX_CACHE]);
        expect(applyMemoryModePreset(settings, 'invalid')).toBe(false);
    });

    it('backfills the provider cache TTL from the defaults', () => {
        installSummaryContext({ settings: {} });
        expect(getSettings().cacheTtlMinutes).toBe(defaultSettings.cacheTtlMinutes);
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
    it('preserves every Connection Route key, the Layer 0 response length included', () => {
        const s = settingsFor();
        const edited = {};
        for (const route of Object.values(CONNECTION_ROUTES)) {
            edited[route.sourceKey] = route.sourceOptions.find(
                (option) => option !== route.defaultSource,
            );
            edited[route.profileKey] = `profile-${route.id}`;
            edited[route.responseLengthKey] = 777;
            edited[route.timeoutKey] = 120;
        }
        Object.assign(s, edited);

        resetSettingsToDefaults();

        for (const [key, value] of Object.entries(edited)) {
            expect(s[key], key).toBe(value);
        }
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

    it('keeps the Off Operation Mode and its gate through a reset', () => {
        const s = settingsFor({
            uiMode: UI_MODES.OFF,
            configMode: UI_MODES.ADVANCED,
            enabled: false,
        });

        resetSettingsToDefaults();

        expect(s).toMatchObject({
            uiMode: UI_MODES.OFF,
            configMode: UI_MODES.ADVANCED,
            enabled: false,
        });
    });
});
