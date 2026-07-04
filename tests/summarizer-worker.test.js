import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    summarizeBatchFromTurns: vi.fn(),
    summarizeOneBatchFromTurns: vi.fn(),
    maybePromoteLayer: vi.fn(),
    flushPendingChatSave: vi.fn(),
}));

vi.mock('../src/core/summarizer-batch.js', () => ({
    summarizeBatchFromTurns: mocks.summarizeBatchFromTurns,
    summarizeOneBatchFromTurns: mocks.summarizeOneBatchFromTurns,
}));

vi.mock('../src/core/summarizer-promotion.js', () => ({
    maybePromoteLayer: mocks.maybePromoteLayer,
}));

vi.mock('../src/core/persist-state.js', () => ({
    flushPendingChatSave: mocks.flushPendingChatSave,
}));

function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.flushPendingChatSave.mockResolvedValue(undefined);
    globalThis.toastr = {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
    globalThis.$ = () => ({ find: () => ({ text: vi.fn() }), length: 1 });
});

describe('requestSummarization', () => {
    it('coalesces message events that arrive while a batch request is in flight', async () => {
        const firstBatch = deferred();
        const longTurn = 'x'.repeat(3000);
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
                makeMessage({ mes: longTurn }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
                verbatimTokenBudget: 4000,
                applyRegexScripts: false,
            },
            getTokenCountAsync: async (text) => text.length,
        });

        mocks.summarizeBatchFromTurns
            .mockImplementationOnce(async (turns) => {
                await firstBatch.promise;
                for (const turn of turns) {
                    ctx.chat[turn.index].extra.sc_ghosted = true;
                }
                return true;
            })
            .mockImplementationOnce(async (turns) => {
                for (const turn of turns) {
                    ctx.chat[turn.index].extra.sc_ghosted = true;
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
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
                verbatimTokenBudget: 4000,
                applyRegexScripts: false,
            },
            getTokenCountAsync: async (text) => text.length,
        });

        mocks.summarizeBatchFromTurns.mockImplementation(async (turns) => {
            for (const turn of turns) {
                ctx.chat[turn.index].extra.sc_ghosted = true;
            }
            return true;
        });

        const { requestSummarization } = await import('../src/core/summarizer.js');
        await requestSummarization({ reason: 'new-message', mode: 'auto' });

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
        expect(mocks.maybePromoteLayer).toHaveBeenCalledTimes(1);
    });
});

describe('runCatchup', () => {
    it('requests a reload after a catch-up batch commits', async () => {
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
                verbatimTokenBudget: 4000,
                applyRegexScripts: false,
            },
            getTokenCountAsync: async (text) => text.length,
        });

        mocks.summarizeOneBatchFromTurns.mockImplementationOnce(async (turns) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = turns[turns.length - 1].index;
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        const outcome = await runCatchup([], 1);

        expect(outcome.shouldReload).toBe(true);
        expect(outcome.completed).toBe(1);
    });

    it('does not request a reload when catch-up totally fails', async () => {
        installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
                verbatimTokenBudget: 4000,
                applyRegexScripts: false,
            },
            getTokenCountAsync: async (text) => text.length,
        });

        mocks.summarizeOneBatchFromTurns.mockResolvedValue(false);

        const { runCatchup } = await import('../src/core/summarizer.js');
        const outcome = await runCatchup([], 1);

        expect(outcome.shouldReload).toBe(false);
        expect(outcome.completed).toBe(0);
    });

    it('defers final promotion when the prompt guard activates during catch-up', async () => {
        installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
                makeMessage({ mes: 'x'.repeat(3000) }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 3,
                minSummaryBudget: 1000,
                verbatimTokenBudget: 4000,
                applyRegexScripts: false,
            },
            getTokenCountAsync: async (text) => text.length,
        });

        mocks.summarizeOneBatchFromTurns.mockImplementationOnce(async () => {
            const { beginForegroundGeneration } = await import('../src/core/summarizer-commit.js');
            beginForegroundGeneration();
            return true;
        });

        const { runCatchup } = await import('../src/core/summarizer.js');
        await runCatchup([], 1);

        expect(mocks.summarizeOneBatchFromTurns).toHaveBeenCalledTimes(1);
        expect(mocks.maybePromoteLayer).not.toHaveBeenCalled();
    });
});

describe('runSlopBreaker', () => {
    it('summarizes through the previous countable message and requests reload when committed', async () => {
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'assistant source' }),
                makeMessage({ isUser: true, mes: 'trailing user', name: 'Player' }),
                makeMessage({ isUser: true, mes: 'preserved user', name: 'Player' }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                minSummaryTurns: 3,
                maxSummaryTurns: 5,
                minSummaryBudget: 6000,
                verbatimTokenBudget: 16000,
                applyRegexScripts: false,
            },
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

        setCommitCallbacks({
            reassertInjection,
        });

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
        installSillyTavernStub({
            chat: [],
            settings: {
                enabled: false,
            },
        });
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
});
