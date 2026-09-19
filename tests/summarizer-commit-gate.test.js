import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    beginForegroundGeneration,
    commitWhenSafe,
    endForegroundGeneration,
    promptWorkGate,
    queuePromptEffect,
    resetCommitStateForTests,
} from '../src/core/summarizer-commit.js';
import { installSummaryContext } from './test-helpers.js';

const { logger } = globalThis.summaryceptionFoundationMocks;

/** promptWorkGate is the single foreground ask for prompt-affecting work. */
describe('promptWorkGate', () => {
    afterEach(() => {
        resetCommitStateForTests();
        vi.restoreAllMocks();
    });

    it('returns open when the gate is clear', async () => {
        installSummaryContext({ chat: [] });

        await expect(promptWorkGate('gate test')).resolves.toBe('open');
    });

    it('returns blocked while a foreground generation freezes prompt work', async () => {
        installSummaryContext({ chat: [] });
        beginForegroundGeneration();

        await expect(promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('returns blocked while a commit is queued behind the freeze', async () => {
        installSummaryContext({ chat: [] });
        beginForegroundGeneration();
        const commit = await commitWhenSafe({ kind: 'gate test commit', apply: async () => true });
        expect(commit).toBe('queued');

        await expect(promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('returns blocked while a prompt effect is queued', async () => {
        installSummaryContext({ chat: [] });
        queuePromptEffect({ kind: 'gate test effect', apply: () => true });

        await expect(promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('recovers a stale freeze inside the ask and reopens the gate', async () => {
        // No streaming processor and no stop button, so SillyTavern is not generating.
        installSummaryContext({ chat: [] });
        beginForegroundGeneration();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 1001); // past the stale-freeze heartbeat grace

            await expect(promptWorkGate('gate test')).resolves.toBe('open');
            await expect(promptWorkGate('gate test again')).resolves.toBe('open');
            await expect(endForegroundGeneration()).resolves.toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('endForegroundGeneration logging', () => {
    afterEach(() => {
        resetCommitStateForTests();
        vi.restoreAllMocks();
    });

    it('logs one freeze-off line with the pending counts before flushing', async () => {
        installSummaryContext({ chat: [] });
        beginForegroundGeneration();
        await commitWhenSafe({ kind: 'gate log commit', apply: async () => true });
        queuePromptEffect({ kind: 'gate log effect', apply: () => true });
        logger.info.mockClear();

        await endForegroundGeneration();

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            'Foreground freeze off; commits=1, effects=1 flushed.',
        );
    });

    it('logs no second line when a repeat end has nothing pending', async () => {
        installSummaryContext({ chat: [] });
        beginForegroundGeneration();
        logger.info.mockClear();

        await endForegroundGeneration();
        await endForegroundGeneration();

        expect(logger.info).toHaveBeenCalledTimes(1);
    });
});
