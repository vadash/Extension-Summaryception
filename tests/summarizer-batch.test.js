import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSummaryContext, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
    ghostMessagesInRange: vi.fn(),
    repairGhostingForRange: vi.fn(),
    persistChatState: vi.fn(),
}));

vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer: mocks.callSummarizer,
}));

vi.mock('../src/core/ghosting.js', () => ({
    ghostMessagesInRange: mocks.ghostMessagesInRange,
    repairGhostingForRange: mocks.repairGhostingForRange,
}));

vi.mock('../src/core/persist-state.js', () => ({
    persistChatState: mocks.persistChatState,
}));

const VALID_L0_SUMMARY = [
    '[NARRATIVE]',
    'The source turn was summarized into a concise but complete memory.',
    '',
    '[STATE]',
    'current_date_time: 2024-12-03 06 Wed',
].join('\n');

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
});

async function runStaleCase(mutator) {
    const ctx = installBatchContext({
        chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
    });

    mocks.callSummarizer.mockImplementation(async () => {
        mutator(ctx);
        return 'new summary';
    });

    const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
    resetCommitStateForTests();

    const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
    const success = await summarizeBatchFromTurns([{ index: 0, mes: 'source turn' }]);
    const store = ctx.chatMetadata.summaryception;

    expect(success).toBe(false);
    expect(store.layers[0].some((snippet) => snippet.text === 'new summary')).toBe(false);
    expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
}

function installBatchContext(options = {}) {
    const ctx = installSummaryContext(options);
    ctx.chatId = 'chat-a';
    return ctx;
}

describe('summarizeBatchFromTurns stale result rejection', () => {
    it('rejects malformed L0 output before committing or ghosting', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
        });
        mocks.callSummarizer.mockResolvedValue('[Nivalis]');

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();

        const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeBatchFromTurns([{ index: 0, mes: 'source turn' }]);

        expect(success).toBe(false);
        expect(ctx.chatMetadata.summaryception.layers[0]).toEqual([]);
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(-1);
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });

    it('uses an explicit source endpoint for a final user-ended batch', async () => {
        const ctx = installBatchContext({
            chat: [
                makeMessage({ mes: 'assistant source' }),
                makeMessage({ isUser: true, mes: 'trailing user', name: 'Player' }),
                makeMessage({ isUser: true, mes: 'preserved user', name: 'Player' }),
            ],
        });
        mocks.callSummarizer.mockResolvedValue(
            [
                '[NARRATIVE]',
                'new summary',
                '',
                '[STATE]',
                'current_date_time: 2024-12-03 06 Wed',
            ].join('\n'),
        );

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();

        const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeBatchFromTurns([{ index: 0, mes: 'assistant source' }], {
            sourceEndIdx: 1,
        });

        expect(success).toBe(true);
        expect(mocks.callSummarizer.mock.calls[0][0]).toContain('Assistant: assistant source');
        expect(mocks.callSummarizer.mock.calls[0][0]).toContain('Player: trailing user');
        expect(mocks.callSummarizer.mock.calls[0][0]).not.toContain('preserved user');
        expect(ctx.chatMetadata.summaryception.layers[0][0]).toMatchObject({
            turnRange: [0, 1],
            sourceRange: [0, 1],
            currentDateTime: '2024-12-03 06 Wed',
            stateMode: 'snapshot-v1',
        });
        expect(ctx.chatMetadata.summaryception.layers[0][0]).not.toHaveProperty('timelineStart');
        expect(ctx.chatMetadata.summaryception.layers[0][0]).not.toHaveProperty('timelineEnd');
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledWith(0, 1, {
            chatSave: 'deferred',
        });
    });

    it('discards stale results when chat state changes before commit', async () => {
        const staleMutators = [
            (ctx) => {
                ctx.chatId = 'chat-b';
            },
            (ctx) => {
                ctx.chatMetadata.summaryception.summarizedUpTo = 5;
            },
            (ctx) => {
                ctx.chat[0].mes = 'edited source';
            },
            (ctx) => {
                ctx.chatMetadata.summaryception.layers[0].push({ text: 'external summary' });
                ctx.chatMetadata.summaryception.mutationEpoch++;
            },
        ];

        for (const mutator of staleMutators) {
            await runStaleCase(mutator);
        }
    });

    it('defers prompt effects for a completed summary while foreground generation is frozen', async () => {
        installBatchContext({
            chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
        });
        mocks.callSummarizer.mockResolvedValue(VALID_L0_SUMMARY);

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

        const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
        beginForegroundGeneration();
        const success = await summarizeBatchFromTurns([{ index: 0, mes: 'source turn' }]);

        expect(success).toBe(true);
        expect(getPendingCommitCount()).toBe(1);
        expect(updateInjection).not.toHaveBeenCalled();
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();

        await endForegroundGeneration();

        expect(updateInjection).toHaveBeenCalledTimes(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledWith(0, 0, {
            chatSave: 'deferred',
        });
    });

    it('discards a deferred result when summary layers change before unfreeze', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
        });
        mocks.callSummarizer.mockResolvedValue(VALID_L0_SUMMARY);

        const { beginForegroundGeneration, endForegroundGeneration, resetCommitStateForTests } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();

        const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
        beginForegroundGeneration();
        await summarizeBatchFromTurns([{ index: 0, mes: 'source turn' }]);

        ctx.chatMetadata.summaryception.layers[0].push({ text: 'external summary' });
        ctx.chatMetadata.summaryception.mutationEpoch++;
        await endForegroundGeneration();

        const store = ctx.chatMetadata.summaryception;
        expect(store.layers[0].some((snippet) => snippet.text === 'new summary')).toBe(false);
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });
});

describe('summarizeAtomicLayer0Partitions', () => {
    it('commits all cache partitions in one mutation and ghosts once', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'first turn' }), makeMessage({ mes: 'second turn' })],
        });
        mocks.callSummarizer
            .mockResolvedValueOnce(VALID_L0_SUMMARY)
            .mockResolvedValueOnce(VALID_L0_SUMMARY);

        const { resetCommitStateForTests, setCommitCallbacks } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const updateInjection = vi.fn();
        setCommitCallbacks({ updateInjection });

        const { summarizeAtomicLayer0Partitions } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeAtomicLayer0Partitions(
            [
                { turns: [{ index: 0, mes: 'first turn' }], sourceStartIdx: 0, sourceEndIdx: 0 },
                { turns: [{ index: 1, mes: 'second turn' }], sourceStartIdx: 1, sourceEndIdx: 1 },
            ],
            { catchExceptions: true },
        );

        const store = ctx.chatMetadata.summaryception;
        expect(success).toBe(true);
        expect(store.layers[0]).toHaveLength(2);
        expect(store.summarizedUpTo).toBe(1);
        expect(store.mutationEpoch).toBe(1);
        expect(updateInjection).toHaveBeenCalledTimes(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledTimes(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledWith(0, 1, { chatSave: 'deferred' });
    });

    it('feeds each pending snapshot into the next cache partition context', async () => {
        installBatchContext({
            chat: [makeMessage({ mes: 'first turn' }), makeMessage({ mes: 'second turn' })],
            metadata: {
                summaryception: {
                    layers: [[{ text: 'existing memory', sourceRange: [0, 0], timestamp: 1 }]],
                    summarizedUpTo: -1,
                    ghostedIndices: [],
                    mutationEpoch: 0,
                },
            },
        });
        mocks.callSummarizer.mockResolvedValue(VALID_L0_SUMMARY);

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { summarizeAtomicLayer0Partitions } = await import('../src/core/summarizer-batch.js');
        await summarizeAtomicLayer0Partitions(
            [
                { turns: [{ index: 0, mes: 'first turn' }], sourceStartIdx: 0, sourceEndIdx: 0 },
                { turns: [{ index: 1, mes: 'second turn' }], sourceStartIdx: 1, sourceEndIdx: 1 },
            ],
            { catchExceptions: true },
        );

        expect(mocks.callSummarizer).toHaveBeenCalledTimes(2);
        expect(mocks.callSummarizer.mock.calls[0][1]).not.toBe(
            mocks.callSummarizer.mock.calls[1][1],
        );
        expect(mocks.callSummarizer.mock.calls[1][1]).toContain('[CURRENT STATE]');
        expect(mocks.callSummarizer.mock.calls[1][1]).toContain(
            'The source turn was summarized into a concise but complete memory.',
        );
    });

    it('discards all pending snippets if any cache partition fails validation', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'first turn' }), makeMessage({ mes: 'second turn' })],
        });
        mocks.callSummarizer.mockResolvedValueOnce(VALID_L0_SUMMARY).mockResolvedValueOnce('[bad]');

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { summarizeAtomicLayer0Partitions } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeAtomicLayer0Partitions(
            [
                { turns: [{ index: 0, mes: 'first turn' }], sourceStartIdx: 0, sourceEndIdx: 0 },
                { turns: [{ index: 1, mes: 'second turn' }], sourceStartIdx: 1, sourceEndIdx: 1 },
            ],
            { catchExceptions: true },
        );

        const store = ctx.chatMetadata.summaryception;
        expect(success).toBe(false);
        expect(store.layers[0]).toEqual([]);
        expect(store.summarizedUpTo).toBe(-1);
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });

    it('rolls back all pending snippets when post-save persistence fails', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'first turn' }), makeMessage({ mes: 'second turn' })],
        });
        mocks.callSummarizer
            .mockResolvedValueOnce(VALID_L0_SUMMARY)
            .mockResolvedValueOnce(VALID_L0_SUMMARY);
        mocks.ghostMessagesInRange.mockRejectedValueOnce(new Error('boom'));

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { summarizeAtomicLayer0Partitions } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeAtomicLayer0Partitions(
            [
                { turns: [{ index: 0, mes: 'first turn' }], sourceStartIdx: 0, sourceEndIdx: 0 },
                { turns: [{ index: 1, mes: 'second turn' }], sourceStartIdx: 1, sourceEndIdx: 1 },
            ],
            { catchExceptions: true },
        );

        const store = ctx.chatMetadata.summaryception;
        expect(success).toBe(false);
        expect(store.layers[0]).toEqual([]);
        expect(store.summarizedUpTo).toBe(-1);
        expect(store.mutationEpoch).toBe(0);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledTimes(1);
    });

    it('aborts and discards all snippets when summarizedUpTo mutates mid-flight', async () => {
        const ctx = installBatchContext({
            chat: [makeMessage({ mes: 'first turn' }), makeMessage({ mes: 'second turn' })],
        });
        mocks.callSummarizer
            .mockImplementationOnce(async () => {
                ctx.chatMetadata.summaryception.summarizedUpTo = 5;
                return VALID_L0_SUMMARY;
            })
            .mockResolvedValueOnce(VALID_L0_SUMMARY);

        const { resetCommitStateForTests } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { summarizeAtomicLayer0Partitions } = await import('../src/core/summarizer-batch.js');
        const success = await summarizeAtomicLayer0Partitions(
            [
                { turns: [{ index: 0, mes: 'first turn' }], sourceStartIdx: 0, sourceEndIdx: 0 },
                { turns: [{ index: 1, mes: 'second turn' }], sourceStartIdx: 1, sourceEndIdx: 1 },
            ],
            { catchExceptions: true },
        );

        const store = ctx.chatMetadata.summaryception;
        expect(success).toBe(false);
        expect(store.layers[0]).toEqual([]);
        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });
});
