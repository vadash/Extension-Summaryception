import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('orphaned hidden message detection', () => {
    it('matches hidden assistant messages that Summaryception does not own', async () => {
        const { isOrphanedHiddenMessage } = await import('../src/features/maintenance.js');

        expect(isOrphanedHiddenMessage(makeMessage({ isSystem: true }))).toBe(true);
        expect(isOrphanedHiddenMessage(makeMessage({ isHidden: true }))).toBe(true);
        expect(isOrphanedHiddenMessage(makeMessage({ isHidden: true, ghosted: true }))).toBe(false);
        expect(isOrphanedHiddenMessage(makeMessage({ isHidden: true, isUser: true }))).toBe(false);
        expect(isOrphanedHiddenMessage(makeMessage({ isHidden: true, mes: '   ' }))).toBe(false);
        expect(isOrphanedHiddenMessage(makeMessage())).toBe(false);
    });
});

describe('orphan repair', () => {
    it('unhides orphaned messages, continues after slash failures, and saves chat once', async () => {
        const slash = vi.fn(async (command) => {
            if (command === '/unhide 0') {
                throw new Error('slash failed');
            }
        });
        const saveChat = vi.fn(async () => {});
        const progress = vi.fn();
        const ctx = installSillyTavernStub({
            chat: [
                makeMessage({ isSystem: true, mes: 'orphan one' }),
                makeMessage({ isHidden: true, ghosted: true, mes: 'owned' }),
                makeMessage({ isHidden: true, isUser: true, mes: 'user hidden' }),
                makeMessage({ isSystem: true, mes: '   ' }),
                makeMessage({ isHidden: true, mes: 'orphan two' }),
            ],
            executeSlashCommandsWithOptions: slash,
            saveChat,
        });

        const { repairOrphanedMessages } = await import('../src/features/maintenance.js');
        const result = await repairOrphanedMessages({ onProgress: progress });

        expect(result).toEqual({ status: 'repaired', repaired: 2 });
        expect(slash).toHaveBeenNthCalledWith(1, '/unhide 0', { showOutput: false });
        expect(slash).toHaveBeenNthCalledWith(2, '/unhide 4', { showOutput: false });
        expect(saveChat).toHaveBeenCalledTimes(1);
        expect(progress).toHaveBeenNthCalledWith(1, 1);
        expect(progress).toHaveBeenNthCalledWith(2, 2);
        expect(ctx.chat[0].is_system).toBe(false);
        expect(ctx.chat[0].is_hidden).toBeUndefined();
        expect(ctx.chat[4].is_system).toBe(false);
        expect(ctx.chat[4].is_hidden).toBeUndefined();
        expect(ctx.chat[1].extra.sc_ghosted).toBe(true);
    });

    it('does not save when no orphaned messages are found', async () => {
        const slash = vi.fn(async () => {});
        const saveChat = vi.fn(async () => {});
        installSillyTavernStub({
            chat: [
                makeMessage(),
                makeMessage({ isHidden: true, ghosted: true }),
                makeMessage({ isHidden: true, isUser: true }),
            ],
            executeSlashCommandsWithOptions: slash,
            saveChat,
        });

        const { repairOrphanedMessages } = await import('../src/features/maintenance.js');
        await expect(repairOrphanedMessages()).resolves.toEqual({ status: 'none', repaired: 0 });

        expect(slash).not.toHaveBeenCalled();
        expect(saveChat).not.toHaveBeenCalled();
    });
});
