import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    deferred,
    installBrowserRuntimeStub,
    installSummaryContext,
    makeLongMessages,
    makeMessage,
} from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    summarizeBatchFromTurns: vi.fn(),
    summarizeAtomicLayer0Partitions: vi.fn(),
    summarizeOneBatchFromTurns: vi.fn(),
    maybePromoteLayer: vi.fn(),
    hasPromotionOverflow: vi.fn(),
    getCacheFriendlyPlan: vi.fn(),
    flushPendingChatSave: vi.fn(),
}));

vi.mock('../src/core/summarizer-batch.js', () => ({
    summarizeBatchFromTurns: mocks.summarizeBatchFromTurns,
    summarizeAtomicLayer0Partitions: mocks.summarizeAtomicLayer0Partitions,
    summarizeOneBatchFromTurns: mocks.summarizeOneBatchFromTurns,
}));

vi.mock('../src/core/summarizer-promotion.js', () => ({
    maybePromoteLayer: mocks.maybePromoteLayer,
    hasPromotionOverflow: mocks.hasPromotionOverflow,
}));

vi.mock('../src/core/cache-planner.js', () => ({
    getCacheFriendlyPlan: mocks.getCacheFriendlyPlan,
}));

vi.mock('../src/core/persist-state.js', () => ({
    flushPendingChatSave: mocks.flushPendingChatSave,
}));

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.flushPendingChatSave.mockResolvedValue(undefined);
    mocks.hasPromotionOverflow.mockResolvedValue(false);
    mocks.maybePromoteLayer.mockResolvedValue(false);
    mocks.summarizeAtomicLayer0Partitions.mockResolvedValue(true);
    mocks.getCacheFriendlyPlan.mockResolvedValue({ reason: 'none', batchTurns: [] });
    installBrowserRuntimeStub();
});

function workerSettings(overrides = {}) {
    return {
        minSummaryTurns: 2,
        maxSummaryTurns: 3,
        minSummaryBudget: 8000,
        verbatimTokenBudget: 4000,
        ...overrides,
    };
}

function installWorkerContext(options = {}) {
    return installSummaryContext({
        chat: makeLongMessages(4),
        settings: workerSettings(),
        ...options,
    });
}

function mockGhostingSummaries(ctx) {
    mocks.summarizeBatchFromTurns.mockImplementation(async (turns) => {
        for (const turn of turns) {
            ctx.chat[turn.index].extra.sc_ghosted = true;
        }
        const lastTurn = turns[turns.length - 1];
        if (lastTurn) {
            ctx.chatMetadata.summaryception.summarizedUpTo = Math.max(
                ctx.chatMetadata.summaryception.summarizedUpTo,
                lastTurn.index,
            );
        }
        return true;
    });
}

describe('requestSummarization', () => {
    it('coalesces message events that arrive while a batch request is in flight', async () => {
        const firstBatch = deferred();
        const ctx = installWorkerContext({ chat: makeLongMessages(8) });

        mocks.summarizeBatchFromTurns
            .mockImplementationOnce(async (turns) => {
                await firstBatch.promise;
                for (const turn of turns) {
                    ctx.chat[turn.index].extra.sc_ghosted = true;
                }
                const lastTurn = turns[turns.length - 1];
                if (lastTurn) {
                    ctx.chatMetadata.summaryception.summarizedUpTo = lastTurn.index;
                }
                return true;
            })
            .mockImplementationOnce(async (turns) => {
                for (const turn of turns) {
                    ctx.chat[turn.index].extra.sc_ghosted = true;
                }
                const lastTurn = turns[turns.length - 1];
                if (lastTurn) {
                    ctx.chatMetadata.summaryception.summarizedUpTo = lastTurn.index;
                }
                return true;
            });

        const { requestSummarization } = await import('../src/core/summarizer.js');
        const firstRun = requestSummarization({ reason: 'first-message', mode: 'auto' });

        await vi.waitFor(() => expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1));

        const secondRun = requestSummarization({ reason: 'second-message', mode: 'auto' });
        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1);

        firstBatch.resolve();
        await firstRun;
        await secondRun;

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
    });

    it('continues automatic layer-0 batches until visible turns reach the limit', async () => {
        const ctx = installWorkerContext({ chat: makeLongMessages(8) });
        mockGhostingSummaries(ctx);

        const { requestSummarization } = await import('../src/core/summarizer.js');
        await requestSummarization({ reason: 'new-message', mode: 'auto' });

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
        expect(mocks.maybePromoteLayer).not.toHaveBeenCalled();
    });

    it('promotes before starting another automatic layer-0 batch when memory is over limit', async () => {
        installWorkerContext({ chat: makeLongMessages(8) });
        const queue = { setPhase: vi.fn(), getPhase: vi.fn(() => 'idle') };
        mocks.hasPromotionOverflow.mockResolvedValueOnce(true);
        mocks.maybePromoteLayer.mockResolvedValueOnce(true);

        const { runElasticAutoCycle } = await import('../src/core/summarizer-engine.js');
        const result = await runElasticAutoCycle(queue);

        expect(result).toBe('processed');
        expect(mocks.maybePromoteLayer).toHaveBeenCalledTimes(1);
        expect(mocks.summarizeBatchFromTurns).not.toHaveBeenCalled();
    });

    it('routes legacy custom memory mode through the standard automatic engine path', async () => {
        const ctx = installWorkerContext({
            chat: makeLongMessages(4),
            settings: workerSettings({ memoryMode: 'custom' }),
        });
        mockGhostingSummaries(ctx);

        const { requestSummarization } = await import('../src/core/summarizer.js');
        await requestSummarization({ reason: 'new-message', mode: 'auto' });

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalled();
        expect(mocks.getCacheFriendlyPlan).not.toHaveBeenCalled();
    });

    it('delays cache memory until ready, then processes one atomic layer-0 transaction', async () => {
        installWorkerContext({
            settings: workerSettings({ memoryMode: 'cache' }),
        });
        mocks.getCacheFriendlyPlan.mockResolvedValueOnce({
            reason: 'ready',
            liveTokens: 5000,
            cacheBudget: 4000,
            protectedTailTokens: 1000,
            estimatedFlushTokens: 3000,
            batchTurns: [{ index: 0, mes: 'cache source', name: 'Assistant' }],
            partitions: [
                {
                    turns: [{ index: 0, mes: 'cache source', name: 'Assistant' }],
                    sourceStartIdx: 0,
                    sourceEndIdx: 0,
                },
            ],
            overflowCount: 1,
        });

        const { requestSummarization } = await import('../src/core/summarizer.js');
        await requestSummarization({ reason: 'new-message', mode: 'auto' });

        expect(mocks.summarizeAtomicLayer0Partitions).toHaveBeenCalledWith(
            [
                {
                    turns: [{ index: 0, mes: 'cache source', name: 'Assistant' }],
                    sourceStartIdx: 0,
                    sourceEndIdx: 0,
                },
            ],
            { showToasts: true, catchExceptions: true },
        );
        expect(mocks.summarizeBatchFromTurns).not.toHaveBeenCalled();
        expect(mocks.maybePromoteLayer).not.toHaveBeenCalled();
    });
});

describe('runCatchup', () => {
    it('requests a reload after a catch-up batch commits', async () => {
        const ctx = installWorkerContext();
        mocks.summarizeBatchFromTurns.mockImplementationOnce(async (turns) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = turns[turns.length - 1].index;
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        const outcome = await runCatchup([], 1);

        expect(outcome.shouldReload).toBe(true);
        expect(outcome.completed).toBe(1);
    });

    it('reports manual catch-up progress through callbacks', async () => {
        const ctx = installWorkerContext();
        const onStart = vi.fn();
        const onProgress = vi.fn();

        mocks.summarizeBatchFromTurns.mockImplementationOnce(async (turns) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = turns[turns.length - 1].index;
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        await runCatchup([], 1, { onStart, onProgress });

        expect(onStart).toHaveBeenCalledWith(
            expect.objectContaining({
                completed: 0,
                totalBatches: 1,
                label: 'Processing',
                title: 'Summaryception Catch-Up',
            }),
        );
        expect(onProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                completed: 1,
                totalBatches: 1,
                label: 'Processing',
                title: 'Summaryception Catch-Up',
            }),
        );
    });

    it('normalizes promotion pressure between committed catch-up batches', async () => {
        const order = [];
        const ctx = installWorkerContext({ chat: makeLongMessages(8) });
        mocks.summarizeBatchFromTurns.mockImplementation(async (turns) => {
            order.push('layer0');
            ctx.chatMetadata.summaryception.summarizedUpTo = turns[turns.length - 1].index;
            return true;
        });
        mocks.hasPromotionOverflow
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        mocks.maybePromoteLayer.mockImplementation(async () => {
            order.push('promotion');
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        await runCatchup([], 2);

        expect(order.slice(0, 3)).toEqual(['layer0', 'promotion', 'layer0']);
    });

    it('honors an aborted manual catch-up signal before the first batch', async () => {
        installWorkerContext();
        const controller = new AbortController();
        controller.abort();

        const { runCatchup } = await import('../src/core/summarizer.js');
        const outcome = await runCatchup([], 1, { signal: controller.signal });

        expect(outcome.cancelled).toBe(true);
        expect(mocks.summarizeBatchFromTurns).not.toHaveBeenCalled();
    });

    it('does not request a reload when catch-up totally fails', async () => {
        installWorkerContext();
        mocks.summarizeBatchFromTurns.mockResolvedValue(false);

        const { runCatchup } = await import('../src/core/summarizer.js');
        const outcome = await runCatchup([], 1);

        expect(outcome.shouldReload).toBe(false);
        expect(outcome.completed).toBe(0);
    });

    it('defers final promotion when the prompt guard activates during catch-up', async () => {
        installWorkerContext();
        mocks.summarizeBatchFromTurns.mockImplementationOnce(async () => {
            const { beginForegroundGeneration } = await import('../src/core/summarizer-commit.js');
            beginForegroundGeneration();
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        await runCatchup([], 1);

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1);
        expect(mocks.maybePromoteLayer).not.toHaveBeenCalled();
    });
});

describe('runSlopBreaker', () => {
    it('summarizes through the previous countable message and requests reload when committed', async () => {
        const ctx = installWorkerContext({
            chat: [
                makeMessage({ mes: 'assistant source' }),
                makeMessage({ isUser: true, mes: 'trailing user', name: 'Player' }),
                makeMessage({ isUser: true, mes: 'preserved user', name: 'Player' }),
            ],
            settings: workerSettings({
                minSummaryTurns: 3,
                maxSummaryTurns: 5,
                minSummaryBudget: 6000,
                verbatimTokenBudget: 16000,
            }),
        });

        mocks.summarizeBatchFromTurns.mockImplementationOnce(async (_turns, opts) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = opts.sourceEndIdx;
            return true;
        });

        const { runSlopBreaker } = await import('../src/core/summarizer.js');
        const outcome = await runSlopBreaker();

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledWith(
            [{ index: 0, mes: 'assistant source', name: 'Assistant' }],
            { catchExceptions: true, sourceEndIdx: 1 },
        );
        expect(outcome.fullyCommitted).toBe(true);
        expect(outcome.shouldReload).toBe(true);
    });

    it('does not report completion when a slop run stops before the fixed target', async () => {
        const ctx = installWorkerContext({
            chat: [
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'target message' }),
            ],
            settings: workerSettings({
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
            }),
        });

        mocks.summarizeBatchFromTurns.mockImplementationOnce(async (_turns, opts) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = opts.sourceEndIdx;
            return true;
        });

        const { runSlopBreaker } = await import('../src/core/summarizer.js');
        const outcome = await runSlopBreaker();

        expect(outcome.completed).toBe(1);
        expect(outcome.fullyCommitted).toBe(false);
        expect(outcome.shouldReload).toBe(false);
    });

    it('normalizes promotion pressure before continuing a slop breaker run', async () => {
        const order = [];
        const ctx = installWorkerContext({ chat: makeLongMessages(8) });
        mocks.summarizeBatchFromTurns.mockImplementation(async (_turns, opts = {}) => {
            order.push('layer0');
            ctx.chatMetadata.summaryception.summarizedUpTo =
                opts.sourceEndIdx ?? ctx.chatMetadata.summaryception.summarizedUpTo;
            return true;
        });
        mocks.hasPromotionOverflow
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        mocks.maybePromoteLayer.mockImplementation(async () => {
            order.push('promotion');
            return true;
        });

        const { runSlopBreaker } = await import('../src/core/summarizer.js');
        await runSlopBreaker();

        expect(order.slice(0, 3)).toEqual(['layer0', 'promotion', 'layer0']);
    });
});

describe('foreground commit guard', () => {
    it('queues completed background commits until foreground generation ends', async () => {
        const {
            beginForegroundGeneration,
            commitWhenSafe,
            endForegroundGeneration,
            getPendingCommitCount,
            resetCommitStateForTests,
            setCommitCallbacks,
        } = await import('../src/core/summarizer-commit.js');

        resetCommitStateForTests();
        const reassertInjection = vi.fn();
        const setExtensionPrompt = vi.fn();
        const hideMessages = vi.fn();

        setCommitCallbacks({ reassertInjection });
        beginForegroundGeneration();
        const result = await commitWhenSafe({
            kind: 'layer0',
            snapshot: {},
            apply: async () => {
                setExtensionPrompt();
                hideMessages();
                return true;
            },
        });

        expect(result).toBe('queued');
        expect(getPendingCommitCount()).toBe(1);
        expect(reassertInjection).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt).not.toHaveBeenCalled();
        expect(hideMessages).not.toHaveBeenCalled();

        await endForegroundGeneration();

        expect(getPendingCommitCount()).toBe(0);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(hideMessages).toHaveBeenCalledTimes(1);
    });
});

describe('foreground generation save flush', () => {
    it('flushes pending chat saves after queued commits are applied', async () => {
        const order = [];
        installSummaryContext({ chat: [], settings: { enabled: false } });
        mocks.flushPendingChatSave.mockImplementation(async () => {
            order.push('flush');
        });

        const { beginForegroundGeneration, endForegroundGeneration } =
            await import('../src/core/summarizer.js');
        const { commitWhenSafe, resetCommitStateForTests } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();

        beginForegroundGeneration();
        await commitWhenSafe({
            kind: 'layer0',
            snapshot: {},
            apply: async () => {
                order.push('commit');
                return true;
            },
        });

        await endForegroundGeneration();

        expect(order.slice(0, 2)).toEqual(['commit', 'flush']);
    });

    it('refreshes the UI and leaves the prompt guard open when save flushing fails', async () => {
        installSummaryContext({ chat: [], settings: { enabled: false } });
        mocks.flushPendingChatSave.mockRejectedValueOnce(new Error('save failed'));

        const { beginForegroundGeneration, endForegroundGeneration, setUiUpdater } =
            await import('../src/core/summarizer.js');
        const { isPromptMutationFrozen, resetCommitStateForTests } =
            await import('../src/core/summarizer-commit.js');
        const updateUi = vi.fn();

        resetCommitStateForTests();
        setUiUpdater(updateUi);
        beginForegroundGeneration();
        updateUi.mockClear();

        await expect(endForegroundGeneration()).rejects.toThrow('save failed');

        expect(isPromptMutationFrozen()).toBe(false);
        expect(updateUi).toHaveBeenCalledTimes(1);
    });
});
