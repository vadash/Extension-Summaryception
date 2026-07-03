import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

beforeEach(() => {
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

describe('loaded chat reconciliation', () => {
    it('repairs missing ghosting after reload while preserving committed metadata', async () => {
        const order = [];
        const slash = vi.fn(async (command) => {
            order.push(command);
        });
        const metadata = {
            summaryception: {
                layers: [[{ text: 'committed summary', turnRange: [0, 1] }]],
                summarizedUpTo: 1,
                ghostedIndices: [],
            },
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
        expect(slash).toHaveBeenNthCalledWith(1, '/hide 0', { showOutput: false });
        expect(slash).toHaveBeenNthCalledWith(2, '/hide 1', { showOutput: false });
        expect(ctx.chat[0].extra.sc_ghosted).toBe(true);
        expect(ctx.chat[1].extra.sc_ghosted).toBe(true);
        expect(ctx.chatMetadata.summaryception.layers).toEqual(metadata.summaryception.layers);
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(1);
    });
});
