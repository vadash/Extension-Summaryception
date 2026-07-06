import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeContext, makeMessage } from './test-helpers.js';
import {
    PROMOTION_PROMPT_PRESETS,
    PROMPT_PRESETS,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    bumpSummaryStoreMutationEpoch,
    calculateContiguousSummarizedUpTo,
    getChatStore,
    getSummaryStoreMutationEpoch,
    getPlayerName,
    getSettings,
} from '../src/foundation/state.js';

describe('state.js', () => {
    beforeEach(() => {
        delete globalThis.SillyTavern;
    });

    it('backfills settings without clobbering explicit user values', () => {
        installSillyTavernStub({
            settings: {
                enabled: false,
                minSummaryTurns: 4,
                maxSummaryTurns: 7,
                minSummaryBudget: 8000,
                verbatimTokenBudget: 32000,
                memoryTokenBudget: 12000,
            },
        });

        const settings = getSettings();
        for (const key of Object.keys(defaultSettings)) {
            expect(Object.hasOwn(settings, key)).toBe(true);
        }
        expect(settings).toMatchObject({
            enabled: false,
            minSummaryTurns: 4,
            maxSummaryTurns: 7,
            minSummaryBudget: 8000,
            verbatimTokenBudget: 32000,
            memoryTokenBudget: 12000,
            mergeConnectionSource: 'inherit',
        });
    });

    it.each([
        ['', 'narrative', PROMPT_PRESETS.narrative],
        ['Summarize only named locations.', 'custom', 'Summarize only named locations.'],
    ])('migrates a missing prompt preset when loaded', (prompt, preset, saved) => {
        const ctx = installSillyTavernStub({ settings: { summarizerUserPrompt: prompt } });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promptPreset).toBe(preset);
        expect(settings.summarizerUserPrompt).toBe(saved);
        expect(settings.promotionPromptPreset).toBe('narrative');
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it.each([
        ['', 'narrative', PROMOTION_PROMPT_PRESETS.narrative],
        ['Merge only unresolved goals.', 'custom', 'Merge only unresolved goals.'],
    ])('migrates a missing promotion prompt preset when loaded', (prompt, preset, saved) => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionUserPrompt: prompt,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promotionPromptPreset).toBe(preset);
        expect(settings.promotionUserPrompt).toBe(saved);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes removed prompt presets to custom without rewriting prompt text', () => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'gamestate',
                promotionPromptPreset: 'narrative',
                summarizerUserPrompt: 'Old game-state prompt text.',
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promptPreset).toBe('custom');
        expect(settings.summarizerUserPrompt).toBe('Old game-state prompt text.');
        expect(settings.lastCustomPrompt).toBeUndefined();
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes removed promotion prompt presets to custom without rewriting prompt text', () => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionPromptPreset: 'oldmerge',
                promotionUserPrompt: 'Old promotion prompt text.',
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promotionPromptPreset).toBe('custom');
        expect(settings.promotionUserPrompt).toBe('Old promotion prompt text.');
        expect(settings.lastCustomPromotionPrompt).toBeUndefined();
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('migrates legacy combined prompt logging into input and output toggles', () => {
        const ctx = installSillyTavernStub({
            settings: { promptPreset: 'narrative', promptLogMode: true },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promptInputLogMode).toBe(true);
        expect(settings.promptOutputLogMode).toBe(true);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes dynamic verbatim window settings to valid slider values', () => {
        installSillyTavernStub({
            settings: {
                memoryMode: 'invalid',
                customMemoryPosition: 'elsewhere',
                customMemoryRole: 'narrator',
                customMemoryDepth: 10001,
                minSummaryTurns: 9,
                maxSummaryTurns: 4,
                layer0SummaryTokenTarget: 47,
                minSummaryBudget: 6500,
                verbatimTokenBudget: 6500,
                memoryTokenBudget: 6500,
                snippetsPerLayer: 1,
                snippetsPerPromotion: 1,
            },
        });

        expect(getSettings()).toMatchObject({
            memoryMode: 'standard',
            customMemoryPosition: 'in_prompt',
            customMemoryRole: 'system',
            customMemoryDepth: 10000,
            minSummaryTurns: 9,
            maxSummaryTurns: 9,
            layer0SummaryTokenTarget: 80,
            minSummaryBudget: 7000,
            verbatimTokenBudget: 7000,
            memoryTokenBudget: 7000,
            snippetsPerLayer: 10,
            snippetsPerPromotion: 3,
        });
    });

    it('keeps existing narrative prompts untouched when settings are loaded', () => {
        const legacyPrompt =
            'Detailed step-by-step actions\n' +
            'Conditional Environmental & Physical State\n' +
            'Output a single, highly dense chronological paragraph';
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionPromptPreset: 'narrative',
                summarizerUserPrompt: legacyPrompt,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.summarizerUserPrompt).toBe(legacyPrompt);
        expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('allows maximum summary turns up to twenty', () => {
        installSillyTavernStub({
            settings: {
                minSummaryTurns: 3,
                maxSummaryTurns: 24,
            },
        });

        expect(getSettings()).toMatchObject({
            minSummaryTurns: 3,
            maxSummaryTurns: 20,
        });
    });

    it('allows Layer 0 targets up to five hundred and promotion batches up to seven', () => {
        installSillyTavernStub({
            settings: {
                layer0SummaryTokenTarget: 999,
                snippetsPerLayer: 999,
                snippetsPerPromotion: 99,
            },
        });

        expect(getSettings()).toMatchObject({
            layer0SummaryTokenTarget: 500,
            snippetsPerLayer: 100,
            snippetsPerPromotion: 7,
        });
    });

    it('initializes missing chat stores with empty layers and sentinel values', () => {
        const ctx = installSillyTavernStub({ metadata: {} });
        const store = getChatStore();

        expect(ctx.chatMetadata.summaryception).toBe(store);
        expect(store).toMatchObject({
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
            mutationEpoch: 0,
        });
    });

    it('creates ghostedIndices and mutationEpoch lazily if an older save omits them', () => {
        const ctx = makeContext({
            chat: [makeMessage()],
            metadata: { summaryception: { layers: [], summarizedUpTo: -1 } },
            settings: {},
        });
        globalThis.SillyTavern = { getContext: () => ctx };

        expect(getChatStore().ghostedIndices).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('normalizes and bumps the summary mutation epoch', () => {
        installSillyTavernStub({
            metadata: { summaryception: { layers: [], summarizedUpTo: -1, mutationEpoch: 2.5 } },
        });
        const store = getChatStore();

        expect(getSummaryStoreMutationEpoch(store)).toBe(0);
        expect(bumpSummaryStoreMutationEpoch(store)).toBe(1);
        expect(store.mutationEpoch).toBe(1);
    });

    it.each([
        [
            'drops malformed snippets while preserving layer positions',
            {
                layers: [
                    [{ text: 'kept', turnRange: [0, 2] }, { text: 42 }, null, ['bad']],
                    'bad-layer',
                ],
                summarizedUpTo: 2,
                ghostedIndices: [],
            },
            { layers: [[{ text: 'kept', turnRange: [0, 2] }], []] },
        ],
        [
            'normalizes non-array layers to an empty list',
            { layers: { 0: [{ text: 'bad' }] }, summarizedUpTo: 0, ghostedIndices: [] },
            { layers: [] },
        ],
        [
            'normalizes bad summarizedUpTo values to the sentinel',
            { layers: [], summarizedUpTo: Number.POSITIVE_INFINITY, ghostedIndices: [] },
            { summarizedUpTo: -1 },
        ],
        [
            'normalizes duplicate and string ghost indices',
            { layers: [], summarizedUpTo: -1, ghostedIndices: [0, '1', 1, -1, 'bad', 2.5, 3] },
            { ghostedIndices: [0, 1, 3] },
        ],
    ])('%s', (_label, summaryception, expected) => {
        installSillyTavernStub({ metadata: { summaryception } });
        expect(getChatStore()).toMatchObject(expected);
    });

    it('calculates summarized coverage only through contiguous Layer 0 ranges', () => {
        expect(
            calculateContiguousSummarizedUpTo({
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
            }),
        ).toBe(8);
    });

    it('returns the configured player name', () => {
        const ctx = makeContext({ chat: [], metadata: {}, settings: {} });
        ctx.name1 = 'Lyra';
        globalThis.SillyTavern = { getContext: () => ctx };

        getSettings();
        expect(getPlayerName()).toBe('Lyra');
    });
});
