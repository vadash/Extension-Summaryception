import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getChat: vi.fn(() => []),
    getChatStore: vi.fn(() => ({ layers: [] })),
    repairIfBranched: vi.fn(async () => {}),
    repairMissingGhostingForSummaries: vi.fn(async () => {}),
    beginForegroundGeneration: vi.fn(),
    endForegroundGeneration: vi.fn(async () => {}),
    hasActiveAbortController: vi.fn(() => false),
    hasFrozenPromptMutations: vi.fn(() => false),
    maybeSummarizeTurns: vi.fn(async () => {}),
    recoverStalePromptFreeze: vi.fn(async () => false),
    resetPromptMutationGuard: vi.fn(),
    updateInjection: vi.fn(),
    repairOrphanedMessages: vi.fn(async () => {}),
    updateUI: vi.fn(),
}));

vi.mock('../src/foundation/state.js', () => ({
    getChatStore: mocks.getChatStore,
}));

vi.mock('../src/core/ghosting-reconcile.js', () => ({
    repairIfBranched: mocks.repairIfBranched,
    repairMissingGhostingForSummaries: mocks.repairMissingGhostingForSummaries,
}));

vi.mock('../src/core/summarizer.js', () => ({
    beginForegroundGeneration: mocks.beginForegroundGeneration,
    endForegroundGeneration: mocks.endForegroundGeneration,
    hasActiveAbortController: mocks.hasActiveAbortController,
    hasFrozenPromptMutations: mocks.hasFrozenPromptMutations,
    maybeSummarizeTurns: mocks.maybeSummarizeTurns,
    recoverStalePromptFreeze: mocks.recoverStalePromptFreeze,
    resetPromptMutationGuard: mocks.resetPromptMutationGuard,
}));

vi.mock('../src/features/injection.js', () => ({
    updateInjection: mocks.updateInjection,
}));

vi.mock('../src/features/maintenance.js', () => ({
    repairOrphanedMessages: mocks.repairOrphanedMessages,
}));

vi.mock('../src/entry/ui.js', () => ({
    updateUI: mocks.updateUI,
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete globalThis.window;
    delete globalThis.document;
    globalThis.summaryceptionFoundationMocks.context.getChat.mockImplementation(mocks.getChat);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete globalThis.window;
    delete globalThis.document;
});

describe('entry lifecycle events', () => {
    it('recovers stale prompt freezes when the chat changes', async () => {
        const { onChatChanged } = await import('../src/entry/events.js');

        onChatChanged();

        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('chat change', {
            refreshUi: mocks.updateUI,
        });
    });

    it('resets prompt guard state before app-ready reconciliation', async () => {
        const order = [];
        mocks.resetPromptMutationGuard.mockImplementationOnce(() => order.push('reset'));
        mocks.getChatStore.mockImplementationOnce(() => {
            order.push('store');
            return { layers: [] };
        });
        const { onAppReady } = await import('../src/entry/events.js');

        await onAppReady();

        expect(order.slice(0, 2)).toEqual(['reset', 'store']);
    });

    it('binds one browser lifecycle recovery set', async () => {
        globalThis.window = {
            addEventListener: vi.fn(),
        };
        globalThis.document = {
            addEventListener: vi.fn(),
            visibilityState: 'visible',
            hidden: false,
        };
        const { bindPromptFreezeRecoveryEvents } = await import('../src/entry/events.js');

        bindPromptFreezeRecoveryEvents();
        bindPromptFreezeRecoveryEvents();

        expect(globalThis.window.addEventListener).toHaveBeenCalledTimes(2);
        expect(globalThis.document.addEventListener).toHaveBeenCalledTimes(1);

        const windowHandlers = Object.fromEntries(globalThis.window.addEventListener.mock.calls);
        const documentHandlers = Object.fromEntries(
            globalThis.document.addEventListener.mock.calls,
        );
        expect(Object.keys(windowHandlers)).toEqual(['beforeunload', 'focus']);
        expect(Object.keys(documentHandlers)).toEqual(['visibilitychange']);

        windowHandlers.beforeunload();
        windowHandlers.focus();
        documentHandlers.visibilitychange();

        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('page unload', {
            refreshUi: mocks.updateUI,
        });
        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('window focus', {
            refreshUi: mocks.updateUI,
        });
        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('tab visible', {
            refreshUi: mocks.updateUI,
        });
    });
});
