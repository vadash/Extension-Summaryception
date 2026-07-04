import { describe, expect, it } from 'vitest';
import { makeMessage } from './test-helpers.js';
import { getSlopBreakerPlan } from '../src/core/slop-breaker.js';

const settings = {
    maxSummaryTurns: 2,
};

function getPlan(chat, store = { summarizedUpTo: -1 }, targetIndex) {
    return getSlopBreakerPlan(chat, store, settings, { targetIndex });
}

describe('getSlopBreakerPlan', () => {
    it('summarizes through the latest assistant message', () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'u0', name: 'Player' }),
            makeMessage({ mes: 'a1' }),
        ];

        const plan = getPlan(chat);

        expect(plan.reason).toBe('ready');
        expect(plan.targetIndex).toBe(1);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1]);
        expect(plan.sourceEndIdx).toBe(1);
    });

    it('preserves exactly the newest trailing user message', () => {
        const chat = [
            makeMessage({ mes: 'a0' }),
            makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
            makeMessage({ isUser: true, mes: 'u2', name: 'Player' }),
        ];

        const plan = getPlan(chat);

        expect(plan.reason).toBe('ready');
        expect(plan.targetIndex).toBe(1);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([0]);
        expect(plan.sourceEndIdx).toBe(1);
    });

    it('caps batches by maxSummaryTurns and lets the final batch run below the cap', () => {
        const chat = [
            makeMessage({ mes: 'a0' }),
            makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
            makeMessage({ mes: 'a2' }),
            makeMessage({ isUser: true, mes: 'u3', name: 'Player' }),
            makeMessage({ mes: 'a4' }),
        ];

        const first = getPlan(chat);
        const second = getPlan(chat, { summarizedUpTo: 2 }, first.targetIndex);

        expect(first.batchTurns.map((turn) => turn.index)).toEqual([0, 2]);
        expect(first.sourceEndIdx).toBe(2);
        expect(first.totalBatches).toBe(2);
        expect(second.reason).toBe('ready');
        expect(second.batchTurns.map((turn) => turn.index)).toEqual([4]);
        expect(second.sourceEndIdx).toBe(4);
    });

    it('is a no-op for empty, hidden-only, user-only, or assistant-free target ranges', () => {
        expect(getPlan([]).reason).toBe('none');
        expect(getPlan([makeMessage({ mes: 'hidden', isHidden: true })]).reason).toBe('none');
        expect(getPlan([makeMessage({ isUser: true, mes: 'u0', name: 'Player' })]).reason).toBe(
            'none',
        );
        expect(
            getPlan(
                [
                    makeMessage({ mes: 'a0' }),
                    makeMessage({ isUser: true, mes: 'u1', name: 'Player' }),
                ],
                { summarizedUpTo: 0 },
            ).reason,
        ).toBe('none');
    });
});
