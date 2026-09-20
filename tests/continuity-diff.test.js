import { describe, expect, it } from 'vitest';

import { diffContinuityStates } from '../src/core/continuity-diff.js';

describe('diffContinuityStates', () => {
    const fullState = (overrides = {}) => ({
        turn_count: 2,
        bonds: { 'Quipsy↔User': { bond: 10, sparks: 6, grudge: 1 } },
        agendas: {},
        gm_notes: [],
        physics: {
            location: 'Salon',
            environment: 'Warm',
            posture_and_position: 'Seated',
            contact_points: 'None',
            clothing_state: 'Robe',
        },
        ...overrides,
    });

    it('reports a changed bond field as an old->new pair', () => {
        const prior = fullState();
        const next = fullState({
            bonds: { 'Quipsy↔User': { bond: 12, sparks: 6, grudge: 1 } },
        });

        expect(diffContinuityStates(prior, next)).toEqual({
            bonds: { 'Quipsy↔User': { bond: [10, 12] } },
        });
    });

    it('reports added and removed gm notes', () => {
        const prior = fullState({ gm_notes: ['[R] Vova watches.'] });
        const next = fullState({ gm_notes: ['[T] Quipsy knows.', '[R] Vova watches.'] });

        expect(diffContinuityStates(prior, next)).toEqual({
            gm_notes: { added: ['[T] Quipsy knows.'] },
        });
    });

    it('reports a changed physics field and omits unchanged sections', () => {
        const prior = fullState();
        const next = fullState({
            physics: { ...fullState().physics, location: 'Kitchen' },
        });

        expect(diffContinuityStates(prior, next)).toEqual({
            physics: { location: ['Salon', 'Kitchen'] },
        });
    });

    it('reports scalar sections in schema order', () => {
        const prior = fullState();
        const next = fullState({ turn_count: 3 });

        expect(Object.keys(diffContinuityStates(prior, next))).toEqual(['turn_count']);
        expect(diffContinuityStates(prior, next)).toEqual({ turn_count: [2, 3] });
    });

    it('returns an empty report for identical states', () => {
        expect(diffContinuityStates(fullState(), fullState())).toEqual({});
    });
});
