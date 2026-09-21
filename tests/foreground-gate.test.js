import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSummaryContext, makeForegroundGate } from './test-helpers.js';

const { logger } = globalThis.summaryceptionFoundationMocks;

/** promptWorkGate is the single foreground ask for prompt-affecting work. */
describe('promptWorkGate', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns open when the gate is clear', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();

        await expect(gate.promptWorkGate('gate test')).resolves.toBe('open');
    });

    it('returns blocked while a foreground generation freezes prompt work', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        gate.beginGeneration();

        await expect(gate.promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('returns blocked while a commit is queued behind the freeze', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        gate.beginGeneration();
        const commit = await gate.commitWhenSafe({
            kind: 'gate test commit',
            apply: async () => true,
        });
        expect(commit).toBe('queued');

        await expect(gate.promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('returns blocked while a prompt effect is queued', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        gate.beginGeneration();
        await expect(gate.runEffect({ kind: 'gate test effect', apply: () => true })).resolves.toBe(
            'queued',
        );

        await expect(gate.promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('runs the beforeFreeze hook while the gate still reads open', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        let hookFrozenState = null;

        gate.beginGeneration({
            beforeFreeze: () => {
                hookFrozenState = gate.isFrozen();
            },
        });

        expect(hookFrozenState).toBe(false);
        expect(gate.isFrozen()).toBe(true);
        await expect(gate.promptWorkGate('gate test')).resolves.toBe('blocked');
    });

    it('recovers a stale freeze inside the ask and reopens the gate', async () => {
        // No streaming processor and no stop button, so SillyTavern is not generating.
        installSummaryContext({ chat: [] });
        let clock = 5000;
        const { gate } = makeForegroundGate({ now: () => clock });
        gate.beginGeneration();

        clock += 500; // inside the heartbeat grace window
        await expect(gate.promptWorkGate('gate test')).resolves.toBe('blocked');

        clock += 501; // past it
        await expect(gate.promptWorkGate('gate test')).resolves.toBe('open');
        await expect(gate.promptWorkGate('gate test again')).resolves.toBe('open');
    });
});

describe('endGeneration logging', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs one freeze-off line with the pending counts before flushing', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        gate.beginGeneration();
        await gate.commitWhenSafe({ kind: 'gate log commit', apply: async () => true });
        await gate.runEffect({ kind: 'gate log effect', apply: () => true });
        logger.info.mockClear();

        await gate.endGeneration();

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            'Foreground freeze off; commits=1, effects=1 flushed.',
        );
    });

    it('logs no second line when a repeat end has nothing pending', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        gate.beginGeneration();
        logger.info.mockClear();

        await gate.endGeneration();
        await gate.endGeneration();

        expect(logger.info).toHaveBeenCalledTimes(1);
    });
});

/** The gate's collaborators arrive at construction; nothing is wired twice. */
describe('gate wiring', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reasserts the committed injection when a generation begins', () => {
        installSummaryContext({ chat: [] });
        const { gate, reassertInjection } = makeForegroundGate();

        gate.beginGeneration();

        expect(reassertInjection).toHaveBeenCalledTimes(1);
    });

    it('asks for a fresh pass when a commit reports itself stale', async () => {
        installSummaryContext({ chat: [] });
        const { gate, requeue } = makeForegroundGate();

        await expect(
            gate.commitWhenSafe({ kind: 'stale commit', apply: async () => false }),
        ).resolves.toBe('stale');
        expect(requeue).toHaveBeenCalledWith('stale-stale commit');
    });

    it('re-runs an effect the gate held once the freeze lifts', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        const applied = vi.fn(() => true);
        gate.beginGeneration();

        await expect(gate.runEffect({ kind: 'held effect', apply: applied })).resolves.toBe(
            'queued',
        );
        expect(applied).not.toHaveBeenCalled();

        await gate.endGeneration();

        expect(applied).toHaveBeenCalledTimes(1);
    });

    it('drops the freeze and both queues on reset', async () => {
        installSummaryContext({ chat: [] });
        const { gate } = makeForegroundGate();
        const applied = vi.fn(() => true);
        gate.beginGeneration();
        await gate.commitWhenSafe({ kind: 'reset commit', apply: async () => true });
        await gate.runEffect({ kind: 'reset effect', apply: applied });

        gate.reset();

        expect(gate.isFrozen()).toBe(false);
        await expect(gate.promptWorkGate('after reset')).resolves.toBe('open');
        await gate.endGeneration();
        expect(applied).not.toHaveBeenCalled();
    });
});
