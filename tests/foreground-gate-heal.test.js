import { describe, expect, it, vi } from 'vitest';
import { installSummaryContext, makeForegroundGate } from './test-helpers.js';

describe('stale freeze heal flush', () => {
    // Reproduces the user report: a summary commit queues behind an active
    // foreground generation, and the stale-freeze heal flushes it at generation
    // end. The commit's own prompt effect must land instead of staying queued
    // forever, and the heal must settle.
    it('holds prompt effects a mid-flush generation freezes and settles', async () => {
        installSummaryContext({ chat: [] });
        let clock = 5000;
        const { gate } = makeForegroundGate({ now: () => clock });
        const applied = vi.fn(() => true);

        gate.beginGeneration();
        await expect(
            gate.commitWhenSafe({
                kind: 'heal repro commit',
                // Mirrors commitSnippetMutation, whose apply runs a prompt
                // effect after real async steps (ghosting commands,
                // persistence). The boundary is load-bearing: the heal assigns
                // staleRecoveryPromise only after its synchronous prefix
                // suspends, and the deferral happens in the continuation.
                apply: async () => {
                    await Promise.resolve();
                    // A generation starting mid-flush re-freezes the gate; the
                    // effect is held rather than requeued against an open gate,
                    // which is what would spin the flusher forever.
                    gate.beginGeneration();
                    return await gate.runEffect({
                        kind: 'heal repro effect',
                        apply: () => applied(),
                    });
                },
            }),
        ).resolves.toBe('queued');

        clock += 1100; // past the heartbeat grace; no host generation is running

        let healSettled = false;
        const heal = gate.heal('heal repro').then((verdict) => {
            healSettled = true;
            return verdict;
        });

        // The flush drains through microtasks, so the bound makes a requeue
        // spin fail the test instead of hanging the worker.
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
            expect(applied).not.toHaveBeenCalled();

            // The freeze the mid-flush generation set is the one the gate re-runs
            // the held effect under.
            await gate.endGeneration();
            expect(applied).toHaveBeenCalledTimes(1);
        } finally {
            if (!healSettled) {
                // Refreeze so a spinning flush loop exits and the worker survives.
                gate.beginGeneration();
            }
            await heal.catch(() => {});
        }
    });

    // Reproduces the user report: every normal generation end (success or
    // stop) logged "Stale foreground freeze detected". ST emits
    // GENERATION_ENDED from hideStopButton, after hiding #mes_stop but before
    // activateSendButtons clears body[data-generating]; the heal's liveness
    // probe saw only the finished stream and hidden stop button, concluded no
    // generation was running, and healed a freeze the end handler was about
    // to release itself.
    it('keeps the freeze during the GENERATION_ENDED teardown window', async () => {
        installSummaryContext({ chat: [] });
        let clock = 5000;
        const { gate } = makeForegroundGate({ now: () => clock });

        gate.beginGeneration();

        // End-teardown state at emit time: stream finished, stop button
        // hidden (no stubbed DOM elements), body[data-generating] still set.
        const previousDocument = globalThis.document;
        globalThis.document = { body: { dataset: { generating: 'true' } } };
        try {
            clock += 1100;
            await expect(gate.heal('prompt mutation check')).resolves.toBe(false);
            expect(gate.isFrozen()).toBe(true);
        } finally {
            globalThis.document = previousDocument;
        }
    });
});
