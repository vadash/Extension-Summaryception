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
