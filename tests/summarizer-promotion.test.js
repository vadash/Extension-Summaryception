import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub } from './test-helpers.js';

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

describe('promotion prompt guard', () => {
    it('updates injection for queued promotion commits only after unfreeze', async () => {
        const ctx = installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [[{ text: 'older' }, { text: 'newer' }]],
                    summarizedUpTo: 4,
                    ghostedIndices: [],
                },
            },
            settings: {
                maxLayers: 3,
                snippetsPerLayer: 1,
                snippetsPerPromotion: 2,
            },
        });
        ctx.chatId = 'chat-a';

        const {
            beginForegroundGeneration,
            endForegroundGeneration,
            getPendingCommitCount,
            resetCommitStateForTests,
            setCommitCallbacks,
        } = await import('../src/core/summarizer-commit.js');
        resetCommitStateForTests();
        const updateInjection = vi.fn();
        setCommitCallbacks({ updateInjection });

        const { maybePromoteLayer } = await import('../src/core/summarizer-promotion.js');

        beginForegroundGeneration();
        const promoted = await maybePromoteLayer(0);

        expect(promoted).toBe(true);
        expect(getPendingCommitCount()).toBe(1);
        expect(updateInjection).not.toHaveBeenCalled();

        await endForegroundGeneration();

        expect(updateInjection).toHaveBeenCalledTimes(1);
        expect(ctx.chatMetadata.summaryception.layers[0]).toHaveLength(1);
        expect(ctx.chatMetadata.summaryception.layers[1]).toHaveLength(1);
    });
});
