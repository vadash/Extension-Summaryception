import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    installBrowserRuntimeStub,
    installSillyTavernStub,
    makeMessage,
    makeSummaryStore,
} from './test-helpers.js';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('loaded chat reconciliation', () => {
    it('repairs missing ghosting after reload while preserving committed metadata', async () => {
        const order = [];
        const slash = vi.fn(async (command) => {
            order.push(command);
        });
        const metadata = {
            summaryception: makeSummaryStore({
                layers: [[{ text: 'committed summary', turnRange: [0, 1] }]],
                summarizedUpTo: 1,
            }),
        };
        const ctx = installSillyTavernStub({
            chat: [makeMessage(), makeMessage()],
            metadata,
            executeSlashCommandsWithOptions: slash,
        });

        vi.doMock('../src/features/injection.js', () => ({
            updateInjection: vi.fn(() => order.push('injection')),
        }));
        vi.doMock('../src/entry/ui.js', () => ({
            updateUI: vi.fn(() => order.push('ui')),
        }));

        const { onAppReady } = await import('../src/entry/events.js');
        await onAppReady();

        expect(order[0]).toBe('injection');
        expect(slash).toHaveBeenCalledTimes(1);
        expect(slash).toHaveBeenCalledWith('/hide 0-1', { showOutput: false });
        expect(ctx.chat[0].extra.sc_ghosted).toBe(true);
        expect(ctx.chat[1].extra.sc_ghosted).toBe(true);
        expect(ctx.chatMetadata.summaryception.layers).toEqual(metadata.summaryception.layers);
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(1);
    });

    it('coalesces repeated chat changes into one reconciliation pass', async () => {
        vi.useFakeTimers();
        const repairIfBranched = vi.fn(async () => {});
        const repairMissingGhostingForSummaries = vi.fn(async () => false);
        installSillyTavernStub({
            chat: [],
            metadata: { summaryception: makeSummaryStore() },
        });

        vi.doMock('../src/core/ghosting-reconcile.js', () => ({
            repairIfBranched,
            repairMissingGhostingForSummaries,
        }));
        vi.doMock('../src/features/injection.js', () => ({
            updateInjection: vi.fn(),
        }));
        vi.doMock('../src/entry/ui.js', () => ({
            updateUI: vi.fn(),
        }));

        const { onChatChanged } = await import('../src/entry/events.js');
        onChatChanged();
        onChatChanged();
        onChatChanged();

        await vi.advanceTimersByTimeAsync(100);
        await Promise.resolve();
        await Promise.resolve();

        expect(repairIfBranched).toHaveBeenCalledTimes(1);
        expect(repairMissingGhostingForSummaries).toHaveBeenCalledTimes(1);
    });
});
