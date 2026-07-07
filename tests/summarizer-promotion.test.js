import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    installBrowserRuntimeStub,
    installSillyTavernStub,
    makeSummaryStore,
} from './test-helpers.js';
import { parseSnippet } from '../src/core/summarizer-state.js';

const mocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
}));

const VALID_PROMOTION_SUMMARY =
    'The merged memory preserves the major sequence of events, decisions, and consequences while omitting repeated details from the source snippets and keeping the timeline coherent.';

vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer: mocks.callSummarizer,
}));

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    mocks.callSummarizer.mockResolvedValue(VALID_PROMOTION_SUMMARY);
});

describe('promotion prompt guard', () => {
    it('updates injection for queued promotion commits only after unfreeze', async () => {
        const ctx = installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'older '.repeat(1800) },
                            { text: 'middle '.repeat(1800) },
                            { text: 'newer '.repeat(1800) },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                    summarizedUpTo: 4,
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });
        ctx.chatId = 'chat-a';

        const {
            beginForegroundGeneration,
            endForegroundGeneration,
            getPendingCommitCount,
            resetCommitStateForTests,
            setCommitCallbacks,
        } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const updateInjection = vi.fn();
        setCommitCallbacks({ updateInjection });

        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        beginForegroundGeneration();
        const promoted = await maybePromoteLayer(0);

        expect(promoted).toBe(true);
        expect(getPendingCommitCount()).toBe(1);
        expect(updateInjection).not.toHaveBeenCalled();

        await endForegroundGeneration();

        expect(updateInjection).toHaveBeenCalledTimes(1);
        expect(ctx.chatMetadata.summaryception.layers[0]).toHaveLength(1);
        expect(ctx.chatMetadata.summaryception.layers[1]).toHaveLength(1);
        expect(ctx.chatMetadata.summaryception.layers[1][0]).toMatchObject({
            text: VALID_PROMOTION_SUMMARY,
            mergedCount: 3,
        });
    });

    it('does not promote one over-limit snippet because it cannot be merged', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'a '.repeat(5000) }]],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).not.toHaveBeenCalled();
        expect(getChatStore().layers[0]).toHaveLength(1);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('does not promote two over-limit snippets when the configured batch size is three', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'a '.repeat(2500) }, { text: 'b '.repeat(2500) }]],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).not.toHaveBeenCalled();
        expect(getChatStore().layers[0]).toHaveLength(2);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('promotes three over-limit snippets into the next layer', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1800) },
                            { text: 'b '.repeat(1800) },
                            { text: 'c '.repeat(1800) },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(1);
        expect(getChatStore().layers[1]).toHaveLength(1);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: VALID_PROMOTION_SUMMARY,
            mergedCount: 3,
        });
    });

    it('rejects tiny promotion output before removing source snippets', async () => {
        mocks.callSummarizer.mockResolvedValue('[Nivalis]');
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1800) },
                            { text: 'b '.repeat(1800) },
                            { text: 'c '.repeat(1800) },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(4);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('skips L0 promotion when the projected remainder would fall below the retention floor', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1800) },
                            { text: 'b '.repeat(1800) },
                            { text: 'c '.repeat(1800) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).not.toHaveBeenCalled();
        expect(getChatStore().layers[0]).toHaveLength(3);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('does not promote for token pressure when raw snippets exceed budget but injection fits', async () => {
        const repeatedState = 'safe '.repeat(1800);
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: `[NARRATIVE]\none\n\n[STATE]\nlocation: ${repeatedState}`,
                            },
                            {
                                text: `[NARRATIVE]\ntwo\n\n[STATE]\nlocation: ${repeatedState}`,
                            },
                            {
                                text: `[NARRATIVE]\nthree\n\n[STATE]\nlocation: ${repeatedState}`,
                            },
                        ],
                    ],
                }),
            },
            settings: {
                injectionTemplate: '{{summary}}',
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).not.toHaveBeenCalled();
        expect(getChatStore().layers[0]).toHaveLength(3);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('still promotes when snippet count exceeds the layer limit', async () => {
        mocks.callSummarizer.mockResolvedValue('merged');
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        Array.from({ length: 11 }, (_value, index) => ({
                            text: index === 10 ? 'tail '.repeat(1000) : `memory ${index}`,
                        })),
                    ],
                }),
            },
            settings: {
                injectionTemplate: '{{summary}}',
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(8);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: 'merged',
            mergedCount: 3,
        });
    });

    it('sends narratives plus source state to promotion and stores narrative-only output', async () => {
        mocks.callSummarizer.mockResolvedValue('Merged narrative.');
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nFirst event.\n\n[STATE]\nlocation: tower\nhooks: open gate',
                                sourceRange: [10, 12],
                                timelineStart: '2024-12-03 06 Wed',
                                timelineEnd: '2024-12-03 07 Wed',
                            },
                            {
                                text: '[NARRATIVE]\nSecond event.\n\n[STATE]\nplace: dock\ninventory: key',
                                sourceRange: [13, 14],
                                timelineStart: '2024-12-03 08 Wed',
                                timelineEnd: '2024-12-03 08 Wed',
                            },
                            {
                                text: '[NARRATIVE]\nThird event.\n\n[STATE]\nhooks: resolved\ncounters: score 2',
                                sourceRange: [15, 16],
                                currentDateTime: '2024-12-03 09 Wed',
                                timelineEnd: '2024-12-03 09 Wed',
                            },
                            { text: '[NARRATIVE]\nExtra 1.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 2.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 3.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 4.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 5.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 6.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 7.\n\n[STATE]' },
                            { text: `[NARRATIVE]\n${'Extra 8. '.repeat(1000)}\n\n[STATE]` },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledWith(
            [
                '[msgs 10-12; 2024-12-03 06 Wed -> 2024-12-03 07 Wed] First event.',
                '[msgs 13-14; 2024-12-03 08 Wed -> 2024-12-03 08 Wed] Second event.',
                '[msgs 15-16; unknown -> 2024-12-03 09 Wed] Third event.',
            ].join('\n\n'),
            expect.any(String),
            expect.objectContaining({
                kind: 'promotion',
                memoryTokensBefore: expect.any(Number),
                sourceState: expect.stringContaining('[STATE]'),
            }),
        );
        expect(getChatStore().layers[1][0].text).toBe('Merged narrative.');
        expect(getChatStore().layers[1][0]).toMatchObject({
            sourceRange: [10, 16],
            timelineStart: '2024-12-03 06 Wed',
            timelineEnd: '2024-12-03 09 Wed',
            currentDateTime: '2024-12-03 09 Wed',
        });
    });

    it('carries durable promoted L0 state into the oldest remaining L0 snippet', async () => {
        mocks.callSummarizer.mockResolvedValue(VALID_PROMOTION_SUMMARY);
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: [
                                    '[NARRATIVE]',
                                    'First event. '.repeat(400),
                                    '[STATE]',
                                    'current_date_time: 2024-12-06 21 Fri',
                                    'timeline_start: 2024-12-06 20 Fri',
                                    'timeline_end: 2024-12-06 21 Fri',
                                    'location: theater',
                                    'characters: Zoe: sitting',
                                    'hooks: rent: pending payment',
                                    'dynamics: Zoe trusts Vova',
                                    'inventory: brass key',
                                    'counters: rent debt: owed',
                                ].join('\n'),
                            },
                            { text: '[NARRATIVE]\nSecond event. '.repeat(400) },
                            { text: '[NARRATIVE]\nThird event. '.repeat(400) },
                            {
                                text: '[NARRATIVE]\nRemaining tail. '.repeat(1000) + '\n[STATE]',
                            },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');
        const { parseSnippet } = await import('../src/core/summarizer-state.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        const remaining = parseSnippet(getChatStore().layers[0][0].text);
        expect(remaining.state).toMatchObject({
            current_date_time: '2024-12-06 21 Fri',
            hooks: 'rent: pending payment',
            dynamics: 'Zoe trusts Vova',
            inventory: 'brass key',
            counters: 'rent debt: owed',
        });
        expect(remaining.state).not.toHaveProperty('location');
        expect(remaining.state).not.toHaveProperty('characters');
        expect(remaining.state).not.toHaveProperty('timeline_start');
        expect(remaining.state).not.toHaveProperty('timeline_end');
    });

    it('strips LLM-produced state when promotion output includes [STATE]', async () => {
        mocks.callSummarizer.mockResolvedValue(
            [
                '[NARRATIVE]',
                'The trio advanced through the dock, resolved the immediate danger, secured a boat, and carried the consequences forward without repeating earlier setup details.',
                '',
                '[STATE]',
                'location: harbor',
                'inventory: boat, key',
                'counters: score 5',
            ].join('\n'),
        );
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: `[NARRATIVE]\n${'first event. '.repeat(400)}\n\n[STATE]\nlocation: tower\nhooks: open gate\ndynamics: wary`,
                            },
                            {
                                text: `[NARRATIVE]\n${'second event. '.repeat(400)}\n\n[STATE]\nplace: dock\ninventory: key`,
                            },
                            {
                                text: `[NARRATIVE]\n${'third event. '.repeat(400)}\n\n[STATE]\nhooks: resolved\ncounters: score 2`,
                            },
                            { text: `[NARRATIVE]\n${'extra 1. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 2. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 3. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 4. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 5. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 6. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 7. '.repeat(400)}\n\n[STATE]` },
                            { text: `[NARRATIVE]\n${'extra 8. '.repeat(400)}\n\n[STATE]` },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        const storedText = getChatStore().layers[1][0].text;
        const parsed = parseStoredSnippet(storedText);
        expect(parsed.narrative).toBe(
            'The trio advanced through the dock, resolved the immediate danger, secured a boat, and carried the consequences forward without repeating earlier setup details.',
        );
        expect(parsed.state).toEqual({});
    });

    it('treats an explicit empty promotion state as authoritative', async () => {
        mocks.callSummarizer.mockResolvedValue(
            ['[NARRATIVE]', 'The old setup ended cleanly.', '', '[STATE]'].join('\n'),
        );
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nFirst event.\n\n[STATE]\nlocation: tower\nhooks: open gate',
                            },
                            {
                                text: '[NARRATIVE]\nSecond event.\n\n[STATE]\ninventory: key',
                            },
                            {
                                text: '[NARRATIVE]\nThird event.\n\n[STATE]\ndynamics: wary',
                            },
                            { text: '[NARRATIVE]\nExtra 1.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 2.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 3.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 4.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 5.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 6.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 7.\n\n[STATE]' },
                            { text: `[NARRATIVE]\n${'Extra 8. '.repeat(1000)}\n\n[STATE]` },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(getChatStore().layers[1][0].text).toBe('The old setup ended cleanly.');
    });

    it('repairs promotion output that misses the minimum compression guard', async () => {
        mocks.callSummarizer
            .mockResolvedValueOnce('x '.repeat(2500))
            .mockResolvedValueOnce(
                'The repaired promotion keeps only the durable macro outcome: the first three memories resolve into a consolidated change in position, resources, and unresolved intent while repeated scene texture, dialogue, and transitional actions are discarded. The chronology remains anchored to the promoted source span and preserves only the consequences needed for future continuity.',
            );
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1000) },
                            { text: 'b '.repeat(1000) },
                            { text: 'c '.repeat(1000) },
                            { text: 'extra 1' },
                            { text: 'extra 2' },
                            { text: 'extra 3' },
                            { text: 'extra 4' },
                            { text: 'extra 5' },
                            { text: 'extra 6' },
                            { text: 'extra 7' },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(2);
        expect(mocks.callSummarizer.mock.calls[1][2]).toMatchObject({
            kind: 'promotion',
            promotionRepair: expect.objectContaining({
                outputTokens: expect.any(Number),
                requiredMaxTokens: expect.any(Number),
                rejectedSummary: expect.stringContaining('x '),
            }),
        });
        expect(getChatStore().layers[0]).toHaveLength(8);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: expect.stringContaining('The repaired promotion keeps only'),
            mergedCount: 3,
        });
    });

    it('rejects promotion output when the repair also misses the minimum compression guard', async () => {
        mocks.callSummarizer
            .mockResolvedValueOnce('x '.repeat(2500))
            .mockResolvedValueOnce('y '.repeat(2400));
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1000) },
                            { text: 'b '.repeat(1000) },
                            { text: 'c '.repeat(1000) },
                            { text: 'extra 1' },
                            { text: 'extra 2' },
                            { text: 'extra 3' },
                            { text: 'extra 4' },
                            { text: 'extra 5' },
                            { text: 'extra 6' },
                            { text: 'extra 7' },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 10,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(2);
        expect(getChatStore().layers[0]).toHaveLength(11);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('rejects promotion when the hypothetical injection does not shrink', async () => {
        const repeatedState = 'same '.repeat(1000);
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: `[STATE]\nlocation: ${repeatedState}` },
                            { text: `[STATE]\nlocation: ${repeatedState}` },
                            { text: `[STATE]\nlocation: ${repeatedState}` },
                        ],
                    ],
                }),
            },
            settings: {
                injectionTemplate: '{{summary}}',
                memoryTokenBudget: 32000,
                snippetsPerLayer: 2,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(false);

        expect(mocks.callSummarizer).not.toHaveBeenCalled();
        expect(getChatStore().layers[0]).toHaveLength(3);
        expect(getChatStore().layers[1]).toBeUndefined();
    });

    it('uses three snippets as the defensive minimum for invalid promotion batch settings', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(1800) },
                            { text: 'b '.repeat(1800) },
                            { text: 'c '.repeat(1800) },
                            { text: 'tail '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 1,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(1);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: VALID_PROMOTION_SUMMARY,
            mergedCount: 3,
        });
    });

    it('uses four snippets as the defensive maximum for invalid promotion batch settings', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            { text: 'a '.repeat(900) },
                            { text: 'b '.repeat(900) },
                            { text: 'c '.repeat(900) },
                            { text: 'd '.repeat(900) },
                            { text: 'e '.repeat(1000) },
                        ],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 30,
                snippetsPerPromotion: 99,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(1);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: VALID_PROMOTION_SUMMARY,
            mergedCount: 4,
        });
    });

    it('uses the walkthrough L0 creation gate before L1 exists', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'a '.repeat(600) }]],
                }),
            },
            settings: {
                memoryTokenBudget: 1000,
                snippetsPerLayer: 100,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore, getSettings } = await import('../src/foundation/state.js');
        const { getLayerMemoryQuotas } = await import('../src/core/summarizer-promotion.js');

        await expect(getLayerMemoryQuotas(getChatStore(), getSettings())).resolves.toEqual([
            expect.objectContaining({ layerIndex: 0, quota: 2400, tokens: 600 }),
        ]);
    });

    it('uses pyramid quotas across active L0 and L1 layers', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'a '.repeat(600) }], [{ text: 'b '.repeat(300) }]],
                }),
            },
            settings: {
                memoryTokenBudget: 6000,
                snippetsPerLayer: 100,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: async (text) =>
                String(text || '')
                    .trim()
                    .split(/\s+/).length,
        });

        const { getChatStore, getSettings } = await import('../src/foundation/state.js');
        const { getLayerMemoryQuotas } = await import('../src/core/summarizer-promotion.js');

        await expect(getLayerMemoryQuotas(getChatStore(), getSettings())).resolves.toEqual([
            expect.objectContaining({ layerIndex: 0, quota: 3600, tokens: 600 }),
            expect.objectContaining({ layerIndex: 1, quota: 1800, tokens: 300 }),
        ]);
    });

    it('uses final pyramid quotas and aggregates L2+ token pressure', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [{ text: 'a '.repeat(500) }],
                        [{ text: 'b '.repeat(300) }],
                        [{ text: 'c '.repeat(100) }],
                        [{ text: 'd '.repeat(150) }],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 1000,
                snippetsPerLayer: 100,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore, getSettings } = await import('../src/foundation/state.js');
        const { getLayerMemoryQuotas } = await import('../src/core/summarizer-promotion.js');

        await expect(getLayerMemoryQuotas(getChatStore(), getSettings())).resolves.toEqual([
            expect.objectContaining({ layerIndex: 0, quota: 2000, tokens: 500 }),
            expect.objectContaining({ layerIndex: 1, quota: 1200, tokens: 300 }),
            expect.objectContaining({ layerIndex: 2, quota: 800, tokens: 250 }),
            expect.objectContaining({ layerIndex: 3, quota: 800, tokens: 250 }),
        ]);
    });

    it('promotes the shallowest eligible L2+ layer when the deep bucket overflows', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [{ text: 'l0 '.repeat(100) }],
                        [{ text: 'l1 '.repeat(100) }],
                        [
                            { text: 'l2a '.repeat(300) },
                            { text: 'l2b '.repeat(300) },
                            { text: 'l2c '.repeat(300) },
                        ],
                        [{ text: 'l3 '.repeat(25) }],
                    ],
                }),
            },
            settings: {
                memoryTokenBudget: 1000,
                snippetsPerLayer: 100,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: countWhitespaceTokens,
        });

        const { getChatStore } = await import('../src/foundation/state.js');
        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        await expect(maybePromoteLayer(0)).resolves.toBe(true);

        expect(getChatStore().layers[2]).toHaveLength(0);
        expect(getChatStore().layers[3]).toHaveLength(2);
        expect(getChatStore().layers[3][1]).toMatchObject({
            text: VALID_PROMOTION_SUMMARY,
            fromLayer: 2,
            mergedCount: 3,
        });
    });

    it('preserves layers beyond the hidden creation cap and includes them in quotas', async () => {
        const layers = Array.from({ length: 22 }, () => []);
        layers[0] = [{ text: 'a '.repeat(100) }];
        layers[21] = [{ text: 'deep '.repeat(100) }];
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({ layers }),
            },
            settings: {
                memoryTokenBudget: 1000,
                snippetsPerLayer: 100,
                snippetsPerPromotion: 3,
            },
            getTokenCountAsync: async (text) =>
                String(text || '')
                    .trim()
                    .split(/\s+/).length,
        });

        const { getChatStore, getSettings } = await import('../src/foundation/state.js');
        const { getLayerMemoryQuotas, maybePromoteLayer } =
            await import('../src/core/summarizer-promotion.js');

        const quotas = await getLayerMemoryQuotas(getChatStore(), getSettings());
        expect(quotas.map((quota) => quota.layerIndex)).toEqual([0, 21]);
        await expect(maybePromoteLayer(21)).resolves.toBe(false);
        expect(getChatStore().layers[21]).toHaveLength(1);
    });
});

function countWhitespaceTokens(text) {
    return String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
}

function parseStoredSnippet(text) {
    return parseSnippet(text);
}
