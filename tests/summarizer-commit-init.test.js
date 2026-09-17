import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    beginForegroundGeneration,
    commitWhenSafe,
    endForegroundGeneration,
    initCommitCallbacks,
    resetCommitStateForTests,
    updateCommittedInjection,
} from '../src/core/summarizer-commit.js';
import { installSummaryContext } from './test-helpers.js';

/**
 * initCommitCallbacks is the one-time wiring seam for the Foreground Gate.
 * The composition root calls it once.
 */
describe('initCommitCallbacks', () => {
    afterEach(() => {
        resetCommitStateForTests();
        vi.restoreAllMocks();
    });

    it('wires all three slots so commit paths observe the callbacks', async () => {
        installSummaryContext({ chat: [] });
        const updateInjection = vi.fn();
        const reassertInjection = vi.fn();
        const requeue = vi.fn();
        initCommitCallbacks({ updateInjection, reassertInjection, requeue });

        await expect(updateCommittedInjection()).resolves.toBe('applied');
        expect(updateInjection).toHaveBeenCalledTimes(1);

        beginForegroundGeneration();
        expect(reassertInjection).toHaveBeenCalledTimes(1);

        await endForegroundGeneration();
        await expect(
            commitWhenSafe({ kind: 'init test commit', apply: async () => false }),
        ).resolves.toBe('stale');
        expect(requeue).toHaveBeenCalledTimes(1);
    });

    it('throws on a second init', () => {
        installSummaryContext({ chat: [] });
        initCommitCallbacks({
            updateInjection: vi.fn(),
            reassertInjection: vi.fn(),
            requeue: vi.fn(),
        });

        expect(() =>
            initCommitCallbacks({
                updateInjection: vi.fn(),
                reassertInjection: vi.fn(),
                requeue: vi.fn(),
            }),
        ).toThrow(/double init/);
    });

    it('keeps pre-init calls silent no-ops', async () => {
        installSummaryContext({ chat: [] });

        await expect(updateCommittedInjection()).resolves.toBe('applied');
    });

    it('re-enables init after a test reset', () => {
        installSummaryContext({ chat: [] });
        initCommitCallbacks({
            updateInjection: vi.fn(),
            reassertInjection: vi.fn(),
            requeue: vi.fn(),
        });
        resetCommitStateForTests();

        expect(() =>
            initCommitCallbacks({
                updateInjection: vi.fn(),
                reassertInjection: vi.fn(),
                requeue: vi.fn(),
            }),
        ).not.toThrow();
    });
});
