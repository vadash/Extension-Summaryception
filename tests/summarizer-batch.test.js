import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
    ghostMessage: vi.fn(),
    ghostMessagesUpTo: vi.fn(),
    persistChatState: vi.fn(),
}));

vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer: mocks.callSummarizer,
}));

vi.mock('../src/core/ghosting.js', () => ({
    ghostMessage: mocks.ghostMessage,
    ghostMessagesUpTo: mocks.ghostMessagesUpTo,
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
            turnsPerSummary: 1,
            verbatimTurns: 0,
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
    expect(mocks.ghostMessagesUpTo).not.toHaveBeenCalled();
}

describe('summarizeBatchFromTurns stale result rejection', () => {
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
});
