import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';
import { getSlopBreakerPlan } from '../src/core/slop-breaker.js';

const settings = {
    minSummaryTurns: 2,
    maxSummaryTurns: 2,
    minSummaryBudget: 20,
    applyRegexScripts: false,
};

beforeEach(() => {
    vi.resetModules();
    installSillyTavernStub({ getTokenCountAsync: async (text) => String(text || '').length });
});

async function getPlan(chat, store = { summarizedUpTo: -1 }, targetIndex) {
    installSillyTavernStub({ chat, getTokenCountAsync: async (text) => String(text || '').length });
    return await getSlopBreakerPlan(chat, store, settings, { targetIndex });
}

describe('getSlopBreakerPlan', () => {
    it('summarizes through the latest assistant message', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'u0', name: 'Player' }),
            makeMessage({ mes: 'a1' }),
        ];

        const plan = await getPlan(chat);

        expect(plan.reason).toBe('ready');
        expect(plan.targetIndex).toBe(1);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1]);
        expect(plan.sourceEndIdx).toBe(1);
    });

    it('preserves exactly the newest trailing user message', async () => {
        const chat = [
            makeMessage({ mes: 'a0' }),
            makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
            makeMessage({ isUser: true, mes: 'u2', name: 'Player' }),
        ];

        const plan = await getPlan(chat);

        expect(plan.reason).toBe('ready');
        expect(plan.targetIndex).toBe(1);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0]);
        expect(plan.sourceEndIdx).toBe(1);
    });

    it('uses token partitions and lets the final batch run below the cap', async () => {
        const chat = [
            makeMessage({ mes: 'a0' }),
            makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
            makeMessage({ mes: 'a2' }),
            makeMessage({ isUser: true, mes: 'u3', name: 'Player' }),
            makeMessage({ mes: 'a4' }),
        ];

        const first = await getPlan(chat);
        const remaining = first.partitions[1]?.turns || [];
        const second = await getPlan(chat, { summarizedUpTo: 2 }, first.targetIndex);

        expect(first.batchTurns.map((turn) => turn.index)).toEqual([0, 2, 4]);
        expect(first.sourceEndIdx).toBe(4);
        expect(first.totalBatches).toBe(1);
        expect(remaining).toHaveLength(0);
        expect(second.reason).toBe('ready');
    });

    it('is a no-op for empty, hidden-only, user-only, or assistant-free target ranges', async () => {
        expect((await getPlan([])).reason).toBe('none');
        expect((await getPlan([makeMessage({ mes: 'hidden', isHidden: true })])).reason).toBe(
            'none',
        );
        expect(
            (await getPlan([makeMessage({ isUser: true, mes: 'u0', name: 'Player' })])).reason,
        ).toBe('none');
        expect(
            (
                await getPlan(
                    [
                        makeMessage({ mes: 'a0' }),
                        makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
                    ],
                    { summarizedUpTo: 0 },
                )
            ).reason,
        ).toBe('none');
    });
});
