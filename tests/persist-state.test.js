import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function loadPersistState({
    saveChat = vi.fn(async () => {}),
    saveChatStore = vi.fn(async () => {}),
    warn = vi.fn(),
} = {}) {
    vi.doMock('../src/foundation/state.js', () => ({ saveChatStore }));
    globalThis.summaryceptionFoundationMocks.context.saveChat.mockImplementation(saveChat);
    globalThis.summaryceptionFoundationMocks.logger.warn.mockImplementation(warn);

    const mod = await import('../src/core/persist-state.js');
    return { ...mod, saveChat, saveChatStore, warn };
}

describe('persistChatState', () => {
    it('saves metadata immediately and defers chat-file writes', async () => {
        const { persistChatState, saveChat, saveChatStore } = await loadPersistState();

        await persistChatState({ chatSave: 'deferred' });

        expect(saveChatStore).toHaveBeenCalledTimes(1);
        expect(saveChat).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1499);
        expect(saveChat).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it('coalesces repeated deferred chat-file writes', async () => {
        const { persistChatState, saveChat, saveChatStore } = await loadPersistState();

        await persistChatState({ chatSave: 'deferred' });
        await vi.advanceTimersByTimeAsync(500);
        await persistChatState({ chatSave: 'deferred' });
        await vi.advanceTimersByTimeAsync(1500);

        expect(saveChatStore).toHaveBeenCalledTimes(2);
        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it('flushes a pending deferred write when an immediate save is requested', async () => {
        const { persistChatState, saveChat } = await loadPersistState();

        await persistChatState({ chatSave: 'deferred' });
        await persistChatState();
        await vi.advanceTimersByTimeAsync(1500);

        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it('flushes a pending chat-file write explicitly', async () => {
        const { persistChatState, flushPendingChatSave, saveChat } = await loadPersistState();

        await persistChatState({ chatSave: 'deferred' });
        await flushPendingChatSave();
        await vi.advanceTimersByTimeAsync(1500);

        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it('logs chat-file save failures without throwing', async () => {
        const error = new Error('save failed');
        const saveChat = vi.fn(async () => {
            throw error;
        });
        const { persistChatState, warn } = await loadPersistState({ saveChat });

        await expect(persistChatState()).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith('Could not save chat:', error);
    });
});
