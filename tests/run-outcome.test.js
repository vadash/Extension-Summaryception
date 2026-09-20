import { describe, expect, it } from 'vitest';

import { deriveManualRunOutcome } from '../src/core/run-outcome.js';

/** Build the run state one manual run accumulates before its verdict. */
function makeTally(overrides = {}) {
    return {
        completed: 0,
        failed: 0,
        totalBatches: 0,
        aborted: false,
        blocked: false,
        failureLimitReached: false,
        ...overrides,
    };
}

const REACHED = { targetReached: true, promotionCompleted: true };

describe('deriveManualRunOutcome', () => {
    it('reports idle when the run neither committed nor failed a batch', () => {
        expect(deriveManualRunOutcome(makeTally({ totalBatches: 3 }))).toEqual({
            status: 'idle',
            completed: 0,
            failed: 0,
            totalBatches: 3,
        });
    });

    it('reports blocked with zero batches when the gate closed before the run started', () => {
        expect(deriveManualRunOutcome(makeTally({ blocked: true }))).toEqual({
            status: 'blocked',
            completed: 0,
            failed: 0,
            totalBatches: 0,
        });
    });

    it('reports completed only for a reached target with no failures and a drained drain', () => {
        const tally = makeTally({ completed: 2, totalBatches: 2 });

        expect(deriveManualRunOutcome(tally, REACHED)).toEqual({
            status: 'completed',
            completed: 2,
            failed: 0,
            totalBatches: 2,
        });
    });

    it('reports partial when the target was not reached', () => {
        const tally = makeTally({ completed: 2, totalBatches: 3 });
        const facts = { targetReached: false, promotionCompleted: true };

        expect(deriveManualRunOutcome(tally, facts)).toMatchObject({
            status: 'partial',
            completed: 2,
            totalBatches: 3,
        });
    });

    it('reports partial when the target was reached but a batch failed', () => {
        const tally = makeTally({ completed: 2, failed: 1, totalBatches: 3 });

        expect(deriveManualRunOutcome(tally, REACHED).status).toBe('partial');
    });

    it('reports partial when the target was reached but the promotion drain did not finish', () => {
        const tally = makeTally({ completed: 2, totalBatches: 2 });

        expect(
            deriveManualRunOutcome(tally, { targetReached: true, promotionCompleted: false })
                .status,
        ).toBe('partial');
    });

    it('reports failed when the run gave up on consecutive failures', () => {
        const tally = makeTally({
            completed: 2,
            failed: 3,
            totalBatches: 5,
            failureLimitReached: true,
        });

        expect(deriveManualRunOutcome(tally, REACHED)).toEqual({
            status: 'failed',
            completed: 2,
            failed: 3,
            totalBatches: 5,
        });
    });

    it('lets the Foreground Gate outrank the failure limit', () => {
        const tally = makeTally({
            completed: 1,
            failed: 3,
            totalBatches: 4,
            blocked: true,
            failureLimitReached: true,
        });

        expect(deriveManualRunOutcome(tally, REACHED).status).toBe('blocked');
    });

    it('lets an abort outrank the gate and the failure limit', () => {
        const tally = makeTally({
            completed: 1,
            failed: 3,
            totalBatches: 4,
            aborted: true,
            blocked: true,
            failureLimitReached: true,
        });

        expect(deriveManualRunOutcome(tally, REACHED).status).toBe('aborted');
    });
});
