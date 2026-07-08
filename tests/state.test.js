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
        ['', PROMPT_PRESETS.narrative],
        ['Summarize only named locations.', PROMPT_PRESETS.narrative],
    ])('resets a missing prompt preset to the default prompt text', (prompt, saved) => {
        const ctx = installSillyTavernStub({ settings: { summarizerUserPrompt: prompt } });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promptPreset).toBe('narrative');
        expect(settings.summarizerUserPrompt).toBe(saved);
        expect(settings.promotionPromptPreset).toBe('narrative');
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it.each([
        ['', PROMOTION_PROMPT_PRESETS.narrative],
        ['Merge only unresolved goals.', PROMOTION_PROMPT_PRESETS.narrative],
    ])('resets a missing promotion prompt preset to the default prompt text', (prompt, saved) => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionUserPrompt: prompt,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promotionPromptPreset).toBe('narrative');
        expect(settings.promotionUserPrompt).toBe(saved);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes invalid prompt presets to defaults', () => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'invalid',
                promotionPromptPreset: 'narrative',
                summarizerUserPrompt: 'Unexpected prompt text.',
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promptPreset).toBe('narrative');
        expect(settings.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('normalizes invalid promotion prompt presets to defaults', () => {
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionPromptPreset: 'invalid',
                promotionUserPrompt: 'Unexpected promotion prompt text.',
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.promotionPromptPreset).toBe('narrative');
        expect(settings.promotionUserPrompt).toBe(PROMOTION_PROMPT_PRESETS.narrative);
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
            snippetsPerLayer: 20,
            snippetsPerPromotion: 3,
        });
    });

    it('resets edited stock prompts when settings are loaded', () => {
        const editedPrompt =
            'Detailed step-by-step actions\n' +
            'Conditional Environmental & Physical State\n' +
            'Output a single, highly dense chronological paragraph';
        const ctx = installSillyTavernStub({
            settings: {
                promptPreset: 'narrative',
                promotionPromptPreset: 'narrative',
                summarizerUserPrompt: editedPrompt,
            },
        });
        ctx.saveSettingsDebounced = vi.fn();

        const settings = getSettings();

        expect(settings.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledOnce();
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

    it('allows Layer 0 targets up to five hundred and promotion batches up to four', () => {
        installSillyTavernStub({
            settings: {
                layer0SummaryTokenTarget: 999,
                snippetsPerLayer: 999,
                snippetsPerPromotion: 99,
            },
        });

        expect(getSettings()).toMatchObject({
            layer0SummaryTokenTarget: 500,
            snippetsPerLayer: 40,
            snippetsPerPromotion: 4,
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

    it('normalizes chat stores and mutation epoch fields', () => {
        installSillyTavernStub({
            metadata: { summaryception: { layers: [], summarizedUpTo: -1, mutationEpoch: 2.5 } },
        });
        const store = getChatStore();

        expect(getSummaryStoreMutationEpoch(store)).toBe(0);
        expect(bumpSummaryStoreMutationEpoch(store)).toBe(1);
        expect(store.mutationEpoch).toBe(1);

        const normalizationCases = [
            [
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
                { layers: { 0: [{ text: 'bad' }] }, summarizedUpTo: 0, ghostedIndices: [] },
                { layers: [] },
            ],
            [
                { layers: [], summarizedUpTo: Number.POSITIVE_INFINITY, ghostedIndices: [] },
                { summarizedUpTo: -1 },
            ],
            [
                {
                    layers: [],
                    summarizedUpTo: -1,
                    ghostedIndices: [0, '1', 1, -1, 'bad', 2.5, 3],
                },
                { ghostedIndices: [0, 1, 3] },
            ],
        ];

        for (const [summaryception, expected] of normalizationCases) {
            installSillyTavernStub({ metadata: { summaryception } });
            expect(getChatStore()).toMatchObject(expected);
        }
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
