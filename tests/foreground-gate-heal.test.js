import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    beginForegroundGeneration,
    commitWhenSafe,
    initCommitCallbacks,
    recoverStalePromptFreeze,
    resetCommitStateForTests,
    updateCommittedInjection,
} from '../src/core/summarizer-commit.js';
import { installSummaryContext } from './test-helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stale freeze heal flush', () => {
    afterEach(() => {
        resetCommitStateForTests();
        vi.restoreAllMocks();
    });

    // Reproduces the user report: a summary commit queues behind an active
    // foreground generation, the stale-freeze heal flushes it at generation
    // end, and the commit's own prompt effects (injection update, ghosting)
    // must apply during that same flush instead of being requeued forever.
    it('applies prompt effects queued by the heal flush and settles', async () => {
        installSummaryContext({ chat: [] });
        const updateInjection = vi.fn();
        initCommitCallbacks({
            updateInjection,
            reassertInjection: vi.fn(),
            requeue: vi.fn(),
        });
        beginForegroundGeneration();
        await expect(
            commitWhenSafe({
                kind: 'heal repro commit',
                // Mirrors commitSnippetMutation, whose apply runs
                // updateCommittedInjection after real async steps (ghosting
                // commands, persistence). The boundary is load-bearing: the
                // heal assigns staleRecoveryPromise only after its synchronous
                // prefix suspends; the deferral happens in the continuation.
                apply: async () => {
                    await Promise.resolve();
                    await updateCommittedInjection();
                    return true;
                },
            }),
        ).resolves.toBe('queued');

        await sleep(1100);

        let healSettled = false;
        const heal = recoverStalePromptFreeze('heal repro').then((verdict) => {
            healSettled = true;
            return verdict;
        });

        // The flush drains through microtasks; bound it so a requeue spin
        // fails the test instead of hanging the worker.
        let microtasks = 0;
        try {
            const verdict = await Promise.race([
                heal,
                new Promise((_, reject) => {
                    const tick = () => {
                        if (healSettled) {
                            return;
                        }
                        microtasks += 1;
                        if (microtasks > 5000) {
                            reject(
                                new Error(
                                    `heal flush requeued prompt effects for ${microtasks} microtasks without settling`,
                                ),
                            );
                            return;
                        }
                        queueMicrotask(tick);
                    };
                    queueMicrotask(tick);
                }),
            ]);
            expect(verdict).toBe(true);
            expect(updateInjection).toHaveBeenCalledTimes(1);
        } finally {
            if (!healSettled) {
                // Refreeze so a spinning flush loop exits and the worker survives.
                beginForegroundGeneration();
            }
            await heal.catch(() => {});
        }
    });
});
