import { describe, expect, it } from 'vitest';

import {
    classifyContinuity,
    createDefaultContinuity,
    normalizeContinuity,
} from '../src/foundation/continuity.js';

const coldStart = () => ({
    turn_count: 0,
    bonds: {},
    agendas: {},
    gm_notes: [],
    physics: {
        location: '',
        environment: '',
        posture_and_position: '',
        contact_points: '',
        clothing_state: '',
    },
});

const validAuditorJson = () =>
    JSON.stringify({
        turn_count: 42,
        bonds: { 'Quipsy↔User': { bond: 11, sparks: 3, grudge: 0 } },
        agendas: {
            Quipsy: {
                task: 'Survive salon waxing',
                step: { current: 1, max: 3 },
                status: 'Arrived at salon',
                body_state: 'Nervous energy',
                fibs: 'None',
                aware: 'None',
            },
        },
        gm_notes: ['[R] Vova gets aroused easily.', '[S] Quipsy knows the secret.'],
        physics: {
            location: 'Salon',
            environment: 'Busy afternoon',
            posture_and_position: 'Seated',
            contact_points: 'Hand on arm',
            clothing_state: 'Robe',
        },
    });

describe('classifyContinuity', () => {
    it('parses valid Auditor JSON into a clean state with no verdicts', () => {
        const { state, sectionVerdicts } = classifyContinuity(validAuditorJson());
        expect(sectionVerdicts).toEqual([]);
        expect(state).toEqual({
            turn_count: 42,
            bonds: { 'Quipsy↔User': { bond: 11, sparks: 3, grudge: 0 } },
            agendas: {
                Quipsy: {
                    task: 'Survive salon waxing',
                    step: { current: 1, max: 3 },
                    status: 'Arrived at salon',
                    body_state: 'Nervous energy',
                    fibs: 'None',
                    aware: 'None',
                },
            },
            gm_notes: ['[R] Vova gets aroused easily.', '[S] Quipsy knows the secret.'],
            physics: {
                location: 'Salon',
                environment: 'Busy afternoon',
                posture_and_position: 'Seated',
                contact_points: 'Hand on arm',
                clothing_state: 'Robe',
            },
        });
    });

    it('verdicts parse and yields no state for unparseable JSON', () => {
        expect(classifyContinuity('{"turn_count": 42,')).toEqual({
            state: null,
            sectionVerdicts: ['parse'],
        });
    });

    it('verdicts missing sections and keeps the parseable ones', () => {
        const raw = JSON.stringify({
            turn_count: 7,
            bonds: { 'Quipsy↔User': { bond: 0, sparks: 0, grudge: 0 } },
        });
        const { state, sectionVerdicts } = classifyContinuity(raw);
        expect([...sectionVerdicts].sort()).toEqual(['agendas', 'gm_notes', 'physics']);
        expect(state.turn_count).toBe(7);
        expect(state.bonds).toEqual({ 'Quipsy↔User': { bond: 0, sparks: 0, grudge: 0 } });
        expect(state.agendas).toEqual({});
        expect(state.gm_notes).toEqual([]);
        expect(state.physics).toEqual(coldStart().physics);
    });

    it('clamps field damage without emitting verdicts', () => {
        const raw = JSON.stringify({
            turn_count: 4.7,
            bonds: { 'Quipsy↔User': { bond: 100, sparks: -3, grudge: 999 } },
            agendas: {
                Quipsy: {
                    task: 'Train',
                    step: { current: 5, max: 2 },
                    body_state: 42,
                },
                Mirra: { step: { current: 0, max: 500 } },
            },
            gm_notes: ['[T] Deadline Friday'],
            physics: { location: 'Track', clothing_state: null },
        });
        const { state, sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual([]);
        expect(state.turn_count).toBe(5);
        expect(state.bonds['Quipsy↔User']).toEqual({ bond: 20, sparks: 0, grudge: 99 });
        expect(state.agendas.Quipsy).toEqual({
            task: 'Train',
            step: { current: 2, max: 2 },
            status: 'None',
            body_state: 'None',
            fibs: 'None',
            aware: 'None',
        });
        expect(state.agendas.Mirra.step).toEqual({ current: 1, max: 99 });
        expect(state.physics.location).toBe('Track');
        expect(state.physics.clothing_state).toBe('');
    });

    it('verdicts turn_count when the section is missing', () => {
        const raw = JSON.stringify({ bonds: {}, agendas: {}, gm_notes: [], physics: {} });
        const { state, sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual(['turn_count']);
        expect(state.turn_count).toBe(0);
    });

    it('verdicts every missing section when the payload is empty', () => {
        const { state, sectionVerdicts } = classifyContinuity('{}');
        expect([...sectionVerdicts].sort()).toEqual([
            'agendas',
            'bonds',
            'gm_notes',
            'physics',
            'turn_count',
        ]);
        expect(state).toEqual(coldStart());
    });

    it('verdicts bonds on an unknown pair key', () => {
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {
                'Quipsy↔User': { bond: 0, sparks: 0, grudge: 0 },
                'Alice↔Bob': { bond: 0, sparks: 0, grudge: 0 },
            },
            agendas: {},
            gm_notes: [],
            physics: {},
        });
        const { sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual(['bonds']);
    });

    it('verdicts gm_notes on an unknown note tag', () => {
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {},
            agendas: {},
            gm_notes: ['[R] Fine', '[D] Dropped debug tag'],
            physics: {},
        });
        const { sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual(['gm_notes']);
    });

    it('truncates gm_notes to 10 per kind and 20 total', () => {
        const notes = [
            ...Array.from({ length: 12 }, (_, i) => `[R] Reminder ${i + 1}`),
            ...Array.from({ length: 12 }, (_, i) => `[T] Thread ${i + 1}`),
        ];
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {},
            agendas: {},
            gm_notes: notes,
            physics: {},
        });
        const { state, sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual([]);
        expect(state.gm_notes).toHaveLength(20);
        expect(state.gm_notes.filter((note) => note.startsWith('[R]'))).toHaveLength(10);
        expect(state.gm_notes.filter((note) => note.startsWith('[T]'))).toHaveLength(10);
        expect(state.gm_notes[0]).toBe('[R] Reminder 1');
    });

    it('verdicts gm_notes when an unknown tag follows the total cap', () => {
        const notes = [
            ...Array.from({ length: 10 }, (_, i) => `[R] Reminder ${i + 1}`),
            ...Array.from({ length: 10 }, (_, i) => `[T] Thread ${i + 1}`),
            '[D] Late debug tag',
        ];
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {},
            agendas: {},
            gm_notes: notes,
            physics: {},
        });
        const { state, sectionVerdicts } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual(['gm_notes']);
        expect(state.gm_notes).toHaveLength(20);
    });
});

describe('normalizeContinuity', () => {
    it('turns absent stored continuity into the cold-start default', () => {
        expect(normalizeContinuity(undefined)).toEqual(coldStart());
    });

    it('turns garbage stored continuity into the cold-start default without throwing', () => {
        expect(normalizeContinuity('junk')).toEqual(coldStart());
        expect(normalizeContinuity(7)).toEqual(coldStart());
        expect(normalizeContinuity([['bonds']])).toEqual(coldStart());
    });

    it('sanitizes stored continuity in place: clamps fields, drops malformed entries', () => {
        const stored = {
            turn_count: 12,
            bonds: {
                'Quipsy↔User': { bond: 999, sparks: -5, grudge: 3 },
                broken: { bond: 1 },
            },
            agendas: {
                Quipsy: { task: 'Train', step: { current: 9, max: 1 } },
                Mirra: 'gone',
            },
            gm_notes: ['[S] Secret', '[X] Mistagged', 42],
            physics: { location: 'Salon', nope: 'dropped' },
        };
        const normalized = normalizeContinuity(stored);
        expect(normalized).toBe(stored);
        expect(normalized).toEqual({
            turn_count: 12,
            bonds: { 'Quipsy↔User': { bond: 20, sparks: 0, grudge: 3 } },
            agendas: {
                Quipsy: {
                    task: 'Train',
                    step: { current: 1, max: 1 },
                    status: 'None',
                    body_state: 'None',
                    fibs: 'None',
                    aware: 'None',
                },
                Mirra: {
                    task: 'None',
                    step: { current: 1, max: 1 },
                    status: 'None',
                    body_state: 'None',
                    fibs: 'None',
                    aware: 'None',
                },
            },
            gm_notes: ['[S] Secret'],
            physics: { ...coldStart().physics, location: 'Salon' },
        });
    });
});

describe('createDefaultContinuity', () => {
    it('matches the cold-start contract', () => {
        expect(createDefaultContinuity()).toEqual(coldStart());
    });
});
