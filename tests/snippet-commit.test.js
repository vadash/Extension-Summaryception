import { afterEach, describe, expect, it, vi } from 'vitest';

const ghostingMocks = vi.hoisted(() => ({
    syncGhosting: vi.fn(async () => ({ hidden: 0, unhidden: 0 })),
    clearAllGhosting: vi.fn(async () => {}),
}));
vi.mock('../src/core/ghosting.js', () => ghostingMocks);

const refreshMocks = vi.hoisted(() => ({
    refreshInjection: vi.fn(),
}));
vi.mock('../src/foundation/refresh.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, refreshInjection: refreshMocks.refreshInjection };
});

const {
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeNotifyRecorder,
    makeSummaryStore,
} = await import('./test-helpers.js');
const gate = makeForegroundGate().gate;
const { commitSnippetMutation } = await import('../src/core/snippet-commit.js');

describe('commitSnippetMutation', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    function makeStore(overrides = {}) {
        return makeSummaryStore({
            layers: [[{ text: 'old text', sourceMessageIds: ['sc-1'] }]],
            ghostedMessageIds: ['sc-1'],
            mutationEpoch: 3,
            ...overrides,
        });
    }

    function installCommitContext({ store, chat, saveMetadata, saveChat } = {}) {
        const metadataSaver = saveMetadata || vi.fn(async () => {});
        const chatSaver = saveChat || vi.fn(async () => {});
        const context = installSummaryContext({
            chat: chat || [makeMessage({ scId: 'sc-1', mes: 'scene' })],
            metadata: { summaryception: store },
            saveMetadata: metadataSaver,
            saveChat: chatSaver,
        });
        return { context, saveMetadata: metadataSaver, saveChat: chatSaver };
    }

    it('applies the mutation, bumps the epoch, persists, syncs ghosting, and refreshes the gated injection', async () => {
        const store = makeStore();
        const { saveMetadata, saveChat } = installCommitContext({ store });
        let mutated = false;

        const result = await commitSnippetMutation(
            store,
            () => {
                store.layers[0][0].text = 'new text';
                mutated = true;
            },
            { gate },
        );

        expect(mutated).toBe(true);
        expect(store.layers[0][0].text).toBe('new text');
        expect(result).toEqual({ epoch: 4 });
        expect(store.mutationEpoch).toBe(4);
        expect(ghostingMocks.syncGhosting).toHaveBeenCalledTimes(1);
        expect(refreshMocks.refreshInjection).toHaveBeenCalledTimes(1);
        expect(refreshMocks.refreshInjection).toHaveBeenCalledWith({
            logMemoryStatus: true,
        });
        expect(saveMetadata).toHaveBeenCalled();
        expect(saveChat).not.toHaveBeenCalled();
    });

    it("ghost 'none' skips the ghosting step but still commits", async () => {
        const store = makeStore();
        installCommitContext({ store });

        await commitSnippetMutation(store, () => {}, { ghost: 'none', gate });

        expect(ghostingMocks.syncGhosting).not.toHaveBeenCalled();
        expect(ghostingMocks.clearAllGhosting).not.toHaveBeenCalled();
        expect(store.mutationEpoch).toBe(4);
    });

    it("ghost 'clear' releases ghost ownership through clearAllGhosting", async () => {
        const store = makeStore();
        installCommitContext({ store });

        await commitSnippetMutation(store, () => {}, { ghost: 'clear', gate });

        expect(ghostingMocks.clearAllGhosting).toHaveBeenCalledTimes(1);
        expect(ghostingMocks.syncGhosting).not.toHaveBeenCalled();
        expect(store.mutationEpoch).toBe(4);
    });

    it('threads the notify adapter to the ghosting sync', async () => {
        const store = makeStore();
        installCommitContext({ store });
        const notify = makeNotifyRecorder();

        await commitSnippetMutation(store, () => {}, { notify, gate });

        expect(ghostingMocks.syncGhosting).toHaveBeenCalledWith({ notify, gate });
    });

    it('restores the store, runs onRollback, re-saves, and rethrows when persistence fails', async () => {
        const store = makeStore();
        const chat = [makeMessage({ scId: 'sc-1', mes: 'scene' })];
        const saveMetadata = vi.fn(async () => {
            throw new Error('metadata write failed');
        });
        installCommitContext({ store, chat, saveMetadata });
        const chatRollbackPoint = [...chat];
        let rollbackRan = false;

        await expect(
            commitSnippetMutation(
                store,
                () => {
                    store.layers[0][0].text = 'new text';
                    store.layers[0][0].sourceMessageIds.push('sc-9');
                    store.ghostedMessageIds.push('sc-9');
                    chat.push(makeMessage({ scId: 'sc-9', mes: 'extra' }));
                },
                {
                    gate,
                    onRollback: () => {
                        rollbackRan = true;
                        chat.splice(0, chat.length, ...chatRollbackPoint);
                    },
                },
            ),
        ).rejects.toThrow('metadata write failed');

        expect(rollbackRan).toBe(true);
        expect(chat).toEqual(chatRollbackPoint);
        expect(store.layers[0][0].text).toBe('old text');
        expect(store.layers[0][0].sourceMessageIds).toEqual(['sc-1']);
        expect(store.ghostedMessageIds).toEqual(['sc-1']);
        expect(store.mutationEpoch).toBe(3);
        expect(saveMetadata).toHaveBeenCalledTimes(2);
    });

    it("chatSave 'immediate' writes the chat file", async () => {
        const store = makeStore();
        const { saveMetadata, saveChat } = installCommitContext({ store });

        await commitSnippetMutation(store, () => {}, { chatSave: 'immediate', gate });

        expect(saveMetadata).toHaveBeenCalled();
        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    it("chatSave 'deferred' leaves the chat-file write pending", async () => {
        const store = makeStore();
        const { saveChat } = installCommitContext({ store });

        await commitSnippetMutation(store, () => {}, { chatSave: 'deferred', gate });

        expect(saveChat).not.toHaveBeenCalled();
    });
});
