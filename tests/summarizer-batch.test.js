import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

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

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.toastr = {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
});

async function runStaleCase(mutator) {
    const ctx = installSillyTavernStub({
        chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
        settings: {
            enabled: true,
            applyRegexScripts: false,
            minSummaryTurns: 2,
            maxSummaryTurns: 5,
            minSummaryBudget: 6000,
            verbatimTokenBudget: 16000,
        },
    });
    ctx.chatId = 'chat-a';

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

describe('summarizeBatchFromTurns stale result rejection', () => {
    it('uses an explicit source endpoint for a final user-ended batch', async () => {
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'assistant source' }),
                makeMessage({ isUser: true, mes: 'trailing user', name: 'Player' }),
                makeMessage({ isUser: true, mes: 'preserved user', name: 'Player' }),
            ],
            settings: {
                enabled: true,
                applyRegexScripts: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 5,
                minSummaryBudget: 6000,
                verbatimTokenBudget: 16000,
            },
        });
        ctx.chatId = 'chat-a';
        mocks.callSummarizer.mockResolvedValue('new summary');

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
        expect(ctx.chatMetadata.summaryception.layers[0][0].turnRange).toEqual([0, 1]);
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(1);
        expect(mocks.ghostMessagesInRange).toHaveBeenCalledWith(0, 1, {
            chatSave: 'deferred',
        });
    });

    it('discards a result when the chat id changes', async () => {
        await runStaleCase((ctx) => {
            ctx.chatId = 'chat-b';
        });
    });

    it('discards a result when summarizedUpTo changes', async () => {
        await runStaleCase((ctx) => {
            ctx.chatMetadata.summaryception.summarizedUpTo = 5;
        });
    });

    it('discards a result when a source message is edited', async () => {
        await runStaleCase((ctx) => {
            ctx.chat[0].mes = 'edited source';
        });
    });

    it('discards a result when summary layers change', async () => {
        await runStaleCase((ctx) => {
            ctx.chatMetadata.summaryception.layers[0].push({ text: 'external summary' });
        });
    });

    it('defers prompt effects for a completed summary while foreground generation is frozen', async () => {
        const ctx = installSillyTavernStub({
            chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
            settings: {
                enabled: true,
                applyRegexScripts: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 5,
                minSummaryBudget: 6000,
                verbatimTokenBudget: 16000,
            },
        });
        ctx.chatId = 'chat-a';
        mocks.callSummarizer.mockResolvedValue('new summary');

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
        const ctx = installSillyTavernStub({
            chat: [makeMessage({ mes: 'source turn' }), makeMessage({ mes: 'later turn' })],
            settings: {
                enabled: true,
                applyRegexScripts: false,
                minSummaryTurns: 2,
                maxSummaryTurns: 5,
                minSummaryBudget: 6000,
                verbatimTokenBudget: 16000,
            },
        });
        ctx.chatId = 'chat-a';
        mocks.callSummarizer.mockResolvedValue('new summary');

        const { beginForegroundGeneration, endForegroundGeneration, resetCommitStateForTests } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();

        const { summarizeBatchFromTurns } = await import('../src/core/summarizer-batch.js');
        beginForegroundGeneration();
        await summarizeBatchFromTurns([{ index: 0, mes: 'source turn' }]);

        ctx.chatMetadata.summaryception.layers[0].push({ text: 'external summary' });
        await endForegroundGeneration();

        const store = ctx.chatMetadata.summaryception;
        expect(store.layers[0].some((snippet) => snippet.text === 'new summary')).toBe(false);
        expect(mocks.ghostMessagesInRange).not.toHaveBeenCalled();
    });
});
