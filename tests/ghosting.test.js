import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

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
    globalThis.$ = () => ({ find: () => ({ text: vi.fn() }) });
});

describe('ghosting prompt guard', () => {
    it('defers remaining hides when foreground generation starts mid-ghosting', async () => {
        let froze = false;
        const slash = vi.fn(async (command) => {
            if (command === '/hide 0' && !froze) {
                froze = true;
                const { beginForegroundGeneration } =
                    await import('../src/core/summarizer-commit.js');
                beginForegroundGeneration();
            }
        });

        installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'first' }),
                makeMessage({ mes: 'second' }),
                makeMessage({ mes: 'third' }),
            ],
            settings: {
                disableGhosting: false,
            },
            executeSlashCommandsWithOptions: slash,
        });

        const { endForegroundGeneration, getPendingPromptEffectCount, resetCommitStateForTests } =
            await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const { ghostMessagesUpTo } = await import('../src/core/ghosting.js');

        await ghostMessagesUpTo(2);

        expect(slash).toHaveBeenCalledTimes(1);
        expect(slash).toHaveBeenLastCalledWith('/hide 0', { showOutput: false });
        expect(getPendingPromptEffectCount()).toBe(1);

        await endForegroundGeneration();

        expect(slash).toHaveBeenCalledTimes(3);
        expect(slash).toHaveBeenNthCalledWith(2, '/hide 1', { showOutput: false });
        expect(slash).toHaveBeenNthCalledWith(3, '/hide 2', { showOutput: false });
        expect(getPendingPromptEffectCount()).toBe(0);
    });
});

describe('ghosting persistence repair', () => {
    it('unghostAllMessages catches indices from metadata and chat flags', async () => {
        const slash = vi.fn(async () => {});
        const saveChat = vi.fn(async () => {});
        const ctx = installSillyTavernStub({
            chat: [makeMessage({ ghosted: true }), makeMessage({ ghosted: true }), makeMessage()],
            metadata: {
                summaryception: {
                    layers: [],
                    summarizedUpTo: -1,
                    ghostedIndices: [1],
                },
            },
            executeSlashCommandsWithOptions: slash,
            saveChat,
        });

        const { unghostAllMessages } = await import('../src/core/ghosting.js');
        await unghostAllMessages();

        expect(slash).toHaveBeenCalledWith('/unhide 0', { showOutput: false });
        expect(slash).toHaveBeenCalledWith('/unhide 1', { showOutput: false });
        expect(ctx.chat[0].extra.sc_ghosted).toBeUndefined();
        expect(ctx.chat[1].extra.sc_ghosted).toBeUndefined();
        expect(ctx.chatMetadata.summaryception.ghostedIndices).toEqual([]);
        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it('repairs missing ghost flags when summaries exist', async () => {
        const slash = vi.fn(async () => {});
        const ctx = installSillyTavernStub({
            chat: [makeMessage(), makeMessage()],
            metadata: {
                summaryception: {
                    layers: [[{ text: 'summary', turnRange: [0, 1] }]],
                    summarizedUpTo: 1,
                    ghostedIndices: [],
                },
            },
            settings: { disableGhosting: false },
            executeSlashCommandsWithOptions: slash,
        });

        const { repairMissingGhostingForSummaries } =
            await import('../src/core/ghosting-reconcile.js');
        await expect(repairMissingGhostingForSummaries()).resolves.toBe(true);

        expect(slash).toHaveBeenNthCalledWith(1, '/hide 0', { showOutput: false });
        expect(slash).toHaveBeenNthCalledWith(2, '/hide 1', { showOutput: false });
        expect(ctx.chat[0].extra.sc_ghosted).toBe(true);
        expect(ctx.chat[1].extra.sc_ghosted).toBe(true);
        expect(ctx.chatMetadata.summaryception.ghostedIndices).toEqual([0, 1]);
    });

    it('does nothing when summarized ghost flags are already consistent', async () => {
        const slash = vi.fn(async () => {});
        installSillyTavernStub({
            chat: [makeMessage({ ghosted: true }), makeMessage({ ghosted: true })],
            metadata: {
                summaryception: {
                    layers: [[{ text: 'summary', turnRange: [0, 1] }]],
                    summarizedUpTo: 1,
                    ghostedIndices: [0, 1],
                },
            },
            executeSlashCommandsWithOptions: slash,
        });

        const { repairMissingGhostingForSummaries } =
            await import('../src/core/ghosting-reconcile.js');
        await expect(repairMissingGhostingForSummaries()).resolves.toBe(false);

        expect(slash).not.toHaveBeenCalled();
    });
});
