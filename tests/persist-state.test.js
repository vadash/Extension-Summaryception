import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushPendingChatSave, persistChatState } from '../src/core/persist-state.js';
import { warn } from '../src/foundation/logger.js';
import { makeChatPersistence } from './test-helpers.js';

let saveChat;
let saveMetadata;

beforeEach(() => {
    vi.useFakeTimers();
    ({ saveChat, saveMetadata } = makeChatPersistence());
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Chat Persistence init seam', () => {
    it('saves metadata and chat immediately without advancing timers', async () => {
        await persistChatState();

        expect(saveMetadata).toHaveBeenCalledOnce();
        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('defers the chat write past the debounce window', async () => {
        await persistChatState({ chatSave: 'deferred' });

        expect(saveMetadata).toHaveBeenCalledOnce();
        expect(saveChat).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1499);
        expect(saveChat).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();
        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('coalesces back-to-back deferred persists into one chat write', async () => {
        await persistChatState({ chatSave: 'deferred' });
        await persistChatState({ chatSave: 'deferred' });

        expect(saveMetadata).toHaveBeenCalledTimes(2);

        await vi.runAllTimersAsync();
        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('flushes a pending chat write once', async () => {
        await persistChatState({ chatSave: 'deferred' });

        await flushPendingChatSave();
        expect(saveChat).toHaveBeenCalledOnce();

        await flushPendingChatSave();
        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('treats a flush with nothing pending as a no-op', async () => {
        await flushPendingChatSave();

        expect(saveChat).not.toHaveBeenCalled();
    });

    it('swallows a rejecting chat write through the warn log', async () => {
        const boom = new Error('boom');
        saveChat.mockRejectedValue(boom);
        await persistChatState({ chatSave: 'deferred' });

        await expect(flushPendingChatSave()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith('Could not save chat:', boom);

        await vi.runAllTimersAsync();
    });
});
