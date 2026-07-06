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
    resetCatchupDismissed: vi.fn(),
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
    resetCatchupDismissed: mocks.resetCatchupDismissed,
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
    globalThis.summaryceptionFoundationMocks.context.getChat.mockImplementation(mocks.getChat);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete globalThis.window;
});

describe('entry lifecycle events', () => {
    it('recovers stale prompt freezes when the chat changes', async () => {
        const { onChatChanged } = await import('../src/entry/events.js');

        onChatChanged();

        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('chat change', {
            refreshUi: mocks.updateUI,
        });
        expect(mocks.resetCatchupDismissed).toHaveBeenCalledOnce();
    });

    it('binds one beforeunload recovery handler', async () => {
        globalThis.window = {
            addEventListener: vi.fn(),
        };
        const { bindPromptFreezeRecoveryEvents } = await import('../src/entry/events.js');

        bindPromptFreezeRecoveryEvents();
        bindPromptFreezeRecoveryEvents();

        expect(globalThis.window.addEventListener).toHaveBeenCalledTimes(1);
        const [eventName, handler] = globalThis.window.addEventListener.mock.calls[0];
        expect(eventName).toBe('beforeunload');

        handler();

        expect(mocks.recoverStalePromptFreeze).toHaveBeenCalledWith('page unload', {
            refreshUi: mocks.updateUI,
        });
    });
});
