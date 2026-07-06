import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    installBrowserRuntimeStub,
    installSillyTavernStub,
    makeSummaryStore,
} from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
}));

vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer: mocks.callSummarizer,
}));

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    mocks.callSummarizer.mockResolvedValue('merged');
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
        expect(ctx.chatMetadata.summaryception.layers[0]).toHaveLength(0);
        expect(ctx.chatMetadata.summaryception.layers[1]).toHaveLength(1);
        expect(ctx.chatMetadata.summaryception.layers[1][0]).toMatchObject({
            text: 'merged',
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
        expect(getChatStore().layers[0]).toHaveLength(0);
        expect(getChatStore().layers[1]).toHaveLength(1);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: 'merged',
            mergedCount: 3,
        });
    });

    it('sends only narratives to promotion and stores code-merged state', async () => {
        mocks.callSummarizer.mockResolvedValue('Merged narrative.');
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nFirst event.\n\n[STATE]\nlocation: tower\nhooks: open gate',
                            },
                            {
                                text: '[NARRATIVE]\nSecond event.\n\n[STATE]\nplace: dock\ninventory: key',
                            },
                            {
                                text: '[NARRATIVE]\nThird event.\n\n[STATE]\nhooks: resolved\ncounters: score 2',
                            },
                            { text: '[NARRATIVE]\nExtra 1.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 2.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 3.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 4.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 5.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 6.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 7.\n\n[STATE]' },
                            { text: '[NARRATIVE]\nExtra 8.\n\n[STATE]' },
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
            ['First event.', 'Second event.', 'Third event.'].join('\n\n'),
            expect.any(String),
            expect.objectContaining({ kind: 'promotion', memoryTokensBefore: expect.any(Number) }),
        );
        expect(getChatStore().layers[1][0].text).toBe(
            [
                'Merged narrative.',
                '',
                '[STATE]',
                'location: dock',
                'inventory: key',
                'counters: score 2',
            ].join('\n'),
        );
    });

    it('rejects promotion output that is not smaller than its source memory', async () => {
        mocks.callSummarizer.mockResolvedValue('x '.repeat(3000));
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
                            { text: 'extra 8' },
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

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(getChatStore().layers[0]).toHaveLength(11);
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
        expect(getChatStore().layers[0]).toHaveLength(0);
        expect(getChatStore().layers[1][0]).toMatchObject({
            text: 'merged',
            mergedCount: 3,
        });
    });

    it('uses normalized halving quotas across active layers', async () => {
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
            expect.objectContaining({ layerIndex: 0, quota: 4000, tokens: 600 }),
            expect.objectContaining({ layerIndex: 1, quota: 2000, tokens: 300 }),
        ]);
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
