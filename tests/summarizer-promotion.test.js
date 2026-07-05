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
    mocks.callSummarizer.mockResolvedValue('merged memory');
});

describe('promotion prompt guard', () => {
    it('updates injection for queued promotion commits only after unfreeze', async () => {
        const ctx = installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'older' }, { text: 'newer' }]],
                    summarizedUpTo: 4,
                }),
            },
            settings: {
                memoryTokenBudget: 4000,
                snippetsPerLayer: 1,
                snippetsPerPromotion: 2,
            },
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
            text: 'merged memory',
            mergedCount: 2,
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
                snippetsPerPromotion: 2,
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
                snippetsPerPromotion: 2,
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
