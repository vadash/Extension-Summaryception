import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSummaryContext, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
    ghostMessagesInRange: vi.fn(),
    persistChatState: vi.fn(),
    maybePromoteLayer: vi.fn(),
}));

vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer: mocks.callSummarizer,
}));

vi.mock('../src/core/ghosting.js', () => ({
    ghostMessagesInRange: mocks.ghostMessagesInRange,
}));

vi.mock('../src/core/persist-state.js', () => ({
    persistChatState: mocks.persistChatState,
}));

vi.mock('../src/core/summarizer-promotion.js', () => ({
    maybePromoteLayer: mocks.maybePromoteLayer,
}));

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    mocks.ghostMessagesInRange.mockResolvedValue(undefined);
    mocks.persistChatState.mockResolvedValue(undefined);
    mocks.maybePromoteLayer.mockResolvedValue(false);
});

function installCacheContext(options = {}) {
    const ctx = installSummaryContext({
        chat: [
            makeMessage({ mes: 'assistant one' }),
            makeMessage({ isUser: true, mes: 'player reply', name: 'Player' }),
            makeMessage({ mes: 'assistant two' }),
        ],
        settings: {
            memoryMode: 'cache',
            snippetsPerLayer: 100,
            snippetsPerPromotion: 2,
            maxLayers: 5,
        },
        ...options,
    });
    ctx.chatId = 'chat-a';
    ctx.saveMetadata = vi.fn(async () => {});
    return ctx;
}

function cachePlan(overrides = {}) {
    return {
        reason: 'ready',
        flushStartIdx: 0,
        flushEndIdx: 2,
        chunks: [
            { startIdx: 0, endIdx: 0, assistantTurnCount: 1, finalTokens: 1000 },
            { startIdx: 1, endIdx: 2, assistantTurnCount: 1, finalTokens: 2000 },
        ],
        ...overrides,
    };
}

describe('cache-friendly flush transaction', () => {
    it('commits all chunks once after every chunk succeeds', async () => {
        const ctx = installCacheContext();
        mocks.callSummarizer
            .mockResolvedValueOnce('summary one')
            .mockResolvedValueOnce('summary two');

        const { resetCommitStateForTests, setCommitCallbacks } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const updateInjection = vi.fn();
        setCommitCallbacks({ updateInjection });

        const { summarizeCacheFlush } = await import('../src/core/summarizer-cache.js');
        await expect(summarizeCacheFlush(cachePlan())).resolves.toBe('applied');

        const store = ctx.chatMetadata.summaryception;
        expect(store.layers[0]).toEqual([
            expect.objectContaining({ text: 'summary one', turnRange: [0, 0] }),
            expect.objectContaining({ text: 'summary two', turnRange: [1, 2] }),
        ]);
        expect(store.summarizedUpTo).toBe(2);
        expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
        expect(updateInjection).toHaveBeenCalledTimes(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledWith(0, 2, {
            kind: 'cache-flush-ghost',
            chatSave: 'deferred',
        });
    });

    it('feeds earlier draft summaries into later chunk context', async () => {
        installCacheContext({
            metadata: {
                summaryception: {
                    layers: [[{ text: 'old committed memory', turnRange: [0, 0] }]],
                    summarizedUpTo: -1,
                    ghostedIndices: [],
                },
            },
        });
        mocks.callSummarizer
            .mockResolvedValueOnce('summary one')
            .mockResolvedValueOnce('summary two');

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { summarizeCacheFlush } = await import('../src/core/summarizer-cache.js');
        await summarizeCacheFlush(cachePlan());

        expect(mocks.callSummarizer.mock.calls[0][1]).toContain('old committed memory');
        expect(mocks.callSummarizer.mock.calls[1][1]).toContain('old committed memory');
        expect(mocks.callSummarizer.mock.calls[1][1]).toContain('summary one');
    });

    it('commits nothing and ghosts nothing when any chunk fails', async () => {
        const ctx = installCacheContext();
        mocks.callSummarizer.mockResolvedValueOnce('summary one').mockResolvedValueOnce('');

        const { resetCommitStateForTests, setCommitCallbacks } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const updateInjection = vi.fn();
        setCommitCallbacks({ updateInjection });

        const { summarizeCacheFlush } = await import('../src/core/summarizer-cache.js');
        await expect(summarizeCacheFlush(cachePlan())).resolves.toBe('failed');

        const store = ctx.chatMetadata.summaryception;
        expect(store.layers).toEqual([]);
        expect(store.summarizedUpTo).toBe(-1);
        expect(ctx.saveMetadata).not.toHaveBeenCalled();
        expect(updateInjection).not.toHaveBeenCalled();
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });
});
