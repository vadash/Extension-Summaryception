import { describe, expect, it } from 'vitest';

import { makeMessage } from './test-helpers.js';

import { defaultSettings } from '../src/foundation/constants.js';
import {
    applyPairFlags,
    canonicalizePairKey,
    classifyContinuity,
    createDefaultContinuity,
    deriveTurnCount,
    findLiveCheckpoint,
} from '../src/core/continuity-state.js';
import { formatContinuityBlock } from '../src/features/continuity-injection.js';

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

describe('canonicalizePairKey', () => {
    it.each([
        ['Quipsy↔User', 'Quipsy↔User'],
        ['Quipsy ↔ User', 'Quipsy↔User'],
        ['Quipsy↔ User', 'Quipsy↔User'],
        [' Quipsy↔User ', 'Quipsy↔User'],
        ['User↔Quipsy', 'Quipsy↔User'],
        ['User ↔  Quipsy', 'Quipsy↔User'],
    ])('canonicalizes %j to %j', (key, expected) => {
        expect(canonicalizePairKey(key)).toBe(expected);
    });

    it.each([['Alice↔Bob'], ['Quipsy↔user'], ['broken'], ['↔'], [''], [42], [undefined]])(
        'rejects %j',
        (key) => {
            expect(canonicalizePairKey(key)).toBeNull();
        },
    );
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
            flags: {},
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
        const { state, sectionVerdicts, flags } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual([]);
        expect(state.turn_count).toBe(5);
        expect(state.bonds['Quipsy↔User']).toEqual({ bond: 20, sparks: 0, grudge: 99 });
        // flags stay pre-normalization; only the state is clamped.
        expect(flags).toEqual({ 'Quipsy↔User': { bond: 100, sparks: -3, grudge: 999 } });
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

    it.each(['Quipsy ↔ User', 'Quipsy↔ User', 'User↔Quipsy'])(
        'classifies drifted key %j as the known canonical pair',
        (key) => {
            const raw = JSON.stringify({
                turn_count: 1,
                bonds: { [key]: { bond: 2, sparks: 1, grudge: 0 } },
                agendas: {},
                gm_notes: [],
                physics: {},
            });
            const { state, sectionVerdicts, flags } = classifyContinuity(raw);
            expect(sectionVerdicts).toEqual([]);
            expect(state.bonds).toEqual({ 'Quipsy↔User': { bond: 2, sparks: 1, grudge: 0 } });
            expect(flags).toEqual({ 'Quipsy↔User': { bond: 2, sparks: 1, grudge: 0 } });
        },
    );

    it('merges a drifted duplicate into the single canonical pair record', () => {
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {
                'Quipsy↔User': { bond: 3, sparks: 0, grudge: 0 },
                ' Quipsy↔User': { bond: 1, sparks: 0, grudge: 0 },
            },
            agendas: {},
            gm_notes: [],
            physics: {},
        });
        const { state, sectionVerdicts, flags } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual([]);
        expect(Object.keys(state.bonds)).toEqual(['Quipsy↔User']);
        expect(state.bonds).toEqual({ 'Quipsy↔User': { bond: 1, sparks: 0, grudge: 0 } });
        expect(flags).toEqual({ 'Quipsy↔User': { bond: 1, sparks: 0, grudge: 0 } });
    });

    it('verdicts and keeps uncanonicalizable keys as-is in state and flags', () => {
        const raw = JSON.stringify({
            turn_count: 1,
            bonds: {
                'Alice↔Bob': { bond: 4, sparks: 0, grudge: 0 },
                broken: { bond: 2, sparks: 0, grudge: 0 },
            },
            agendas: {},
            gm_notes: [],
            physics: {},
        });
        const { state, sectionVerdicts, flags } = classifyContinuity(raw);
        expect(sectionVerdicts).toEqual(['bonds']);
        expect(state.bonds).toEqual({
            'Alice↔Bob': { bond: 4, sparks: 0, grudge: 0 },
            broken: { bond: 2, sparks: 0, grudge: 0 },
        });
        expect(flags).toEqual({
            'Alice↔Bob': { bond: 4, sparks: 0, grudge: 0 },
            broken: { bond: 2, sparks: 0, grudge: 0 },
        });
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

describe('createDefaultContinuity', () => {
    it('matches the cold-start contract', () => {
        expect(createDefaultContinuity()).toEqual(coldStart());
    });
});

describe('applyPairFlags', () => {
    it('applies plain flag deltas without conversions when turnCount misses both modulos', () => {
        const pair = { bond: 2, sparks: 0, grudge: 0 };
        expect(applyPairFlags(pair, { positive_interaction: true, slight: true }, 1)).toEqual({
            bond: 2,
            sparks: 1,
            grudge: 1,
        });
    });

    it('applies the rulebook in listed order so an apology wipes a same-turn slight', () => {
        const pair = { bond: 0, sparks: 0, grudge: 4 };
        expect(applyPairFlags(pair, { slight: true, apology: true }, 1)).toEqual({
            bond: 0,
            sparks: 0,
            grudge: 0,
        });
    });

    it('subtracts bond for insult and betrayal flags', () => {
        const pair = { bond: 2, sparks: 0, grudge: 0 };
        expect(applyPairFlags(pair, { insult: true, betrayal: true }, 1)).toEqual({
            bond: -1,
            sparks: 0,
            grudge: 0,
        });
    });

    it('converts sparks to bond on turnCount % 5 when sparks reached 7', () => {
        const pair = { bond: 10, sparks: 7, grudge: 0 };
        expect(applyPairFlags(pair, { positive_interaction: true }, 10)).toEqual({
            bond: 11,
            sparks: 0,
            grudge: 0,
        });
    });

    it('halves the sparks-to-bond gain while grudge is 3 or higher', () => {
        const pair = { bond: 10, sparks: 7, grudge: 3 };
        expect(applyPairFlags(pair, { positive_interaction: true }, 10)).toEqual({
            bond: 10,
            sparks: 0,
            grudge: 3,
        });
    });

    it('decays sparks by one on turnCount % 5 only when no positive flag fired', () => {
        expect(applyPairFlags({ bond: 10, sparks: 1, grudge: 0 }, {}, 5)).toEqual({
            bond: 10,
            sparks: 0,
            grudge: 0,
        });
        expect(
            applyPairFlags({ bond: 10, sparks: 3, grudge: 0 }, { positive_interaction: true }, 5),
        ).toEqual({ bond: 10, sparks: 4, grudge: 0 });
    });

    it('converts grudge to bond loss on turnCount % 3 when grudge reached 5', () => {
        expect(applyPairFlags({ bond: 10, sparks: 0, grudge: 5 }, {}, 3)).toEqual({
            bond: 9,
            sparks: 0,
            grudge: 0,
        });
        expect(applyPairFlags({ bond: 10, sparks: 0, grudge: 4 }, {}, 3)).toEqual({
            bond: 10,
            sparks: 0,
            grudge: 3,
        });
    });

    it('runs both conversions on a turnCount divisible by 15', () => {
        expect(applyPairFlags({ bond: 10, sparks: 7, grudge: 5 }, {}, 15)).toEqual({
            bond: 9,
            sparks: 6,
            grudge: 0,
        });
    });

    it('clamps all counters into the schema ranges', () => {
        expect(
            applyPairFlags(
                { bond: 20, sparks: 99, grudge: 99 },
                { positive_interaction: true, slight: true },
                1,
            ),
        ).toEqual({ bond: 20, sparks: 99, grudge: 99 });
        expect(applyPairFlags({ bond: -5, sparks: 0, grudge: 0 }, { insult: true }, 1)).toEqual({
            bond: -5,
            sparks: 0,
            grudge: 0,
        });
    });

    it('treats absent flag fields as false and never mutates the input pair', () => {
        const pair = { bond: 2, sparks: 7, grudge: 5 };
        const snapshot = { ...pair };
        const next = applyPairFlags(pair, {}, 15);
        expect(pair).toEqual(snapshot);
        expect(next.bond).not.toBe(pair.bond);
    });

    it('seeds a first-seen pair at neutral zero instead of the clamp floor', () => {
        expect(applyPairFlags(undefined, { positive_interaction: true }, 1)).toEqual({
            bond: 0,
            sparks: 1,
            grudge: 0,
        });
        expect(applyPairFlags(undefined, { insult: true }, 1)).toEqual({
            bond: -1,
            sparks: 0,
            grudge: 0,
        });
    });

    it('still clamps fields of an existing pair with damaged values', () => {
        expect(applyPairFlags({ bond: 999, sparks: -3, grudge: 50 }, {}, 1)).toEqual({
            bond: 20,
            sparks: 0,
            grudge: 50,
        });
    });
});

describe('deriveTurnCount', () => {
    const chat = [
        makeMessage({ isUser: true, scId: 'u1' }),
        makeMessage({ scId: 'a1' }),
        makeMessage({ isUser: true, scId: 'u2' }),
        makeMessage({ scId: 'a2' }),
        makeMessage({ isSystem: true, scId: 's1' }),
        makeMessage({ isUser: true, scId: 'u3' }),
        makeMessage({ scId: 'a3' }),
    ];

    it('counts every assistant message from chat start, skipping users and system messages', () => {
        expect(deriveTurnCount(chat)).toBe(3);
        expect(deriveTurnCount([])).toBe(0);
        expect(deriveTurnCount(undefined)).toBe(0);
    });
});

describe('gate ladder rendering', () => {
    const stateWithBond = (bond) => ({
        turn_count: 1,
        bonds: { 'X↔User': { bond, sparks: 0, grudge: 0 } },
        agendas: {},
        gm_notes: [],
        physics: coldStart().physics,
    });

    it.each([
        [-5, null],
        [0, null],
        [1, null],
        [2, 'hug'],
        [4, 'hug'],
        [5, 'handhold'],
        [7, 'handhold'],
        [8, 'kiss'],
        [11, 'kiss'],
        [12, 'intimacy'],
        [20, 'intimacy'],
    ])('renders bond %j with gate %j through formatContinuityBlock', (bond, gate) => {
        const block = formatContinuityBlock(stateWithBond(bond));
        expect(block).toContain(
            `X↔User: BOND ${bond < 0 ? '' : '+'}${bond} (Sparks: 0, Grudge: 0)`,
        );
        if (gate === null) {
            expect(block).not.toContain('Gate:');
        } else {
            expect(block).toContain(`; Gate: ${gate}`);
        }
    });
});

describe('findLiveCheckpoint', () => {
    const auditedState = (overrides = {}) => ({
        turn_count: 1,
        bonds: { 'Quipsy↔User': { bond: 2, sparks: 0, grudge: 0 } },
        agendas: {},
        gm_notes: [],
        physics: { ...coldStart().physics, location: 'Salon' },
        ...overrides,
    });

    const withCheckpoint = (message, state) => {
        message.extra.summaryception_continuity = state;
        return message;
    };

    it('returns null for a chat without any checkpoint payload', () => {
        const chat = [makeMessage({ isUser: true, scId: 'u1' }), makeMessage({ scId: 'a1' })];
        expect(findLiveCheckpoint(chat)).toBeNull();
        expect(findLiveCheckpoint(undefined)).toBeNull();
    });

    it('returns the newest payload regardless of user-message positions', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            withCheckpoint(makeMessage({ scId: 'a1' }), auditedState({ turn_count: 1 })),
            makeMessage({ isUser: true, scId: 'u2' }),
            withCheckpoint(makeMessage({ scId: 'a2' }), auditedState({ turn_count: 2 })),
        ];

        const live = findLiveCheckpoint(chat);

        expect(live.state).toEqual(auditedState({ turn_count: 2 }));
        expect(live.index).toBe(3);
    });

    it('keeps newest-wins when the chat has no user message', () => {
        const chat = [
            withCheckpoint(makeMessage({ scId: 'a1' }), auditedState({ turn_count: 1 })),
            withCheckpoint(makeMessage({ scId: 'a2' }), auditedState({ turn_count: 2 })),
        ];

        const live = findLiveCheckpoint(chat);

        expect(live.state).toEqual(auditedState({ turn_count: 2 }));
        expect(live.index).toBe(1);
    });

    it('keeps newest-wins when the checkpoint sits after the last user message', () => {
        // The fresh-audit scenario: the audit lands while the newest user
        // message is still the one before the reply (the old pre-user anchor
        // rule nulled this and killed the injection).
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            withCheckpoint(makeMessage({ scId: 'a1' }), auditedState({ turn_count: 1 })),
        ];

        const live = findLiveCheckpoint(chat);

        expect(live.state).toEqual(auditedState({ turn_count: 1 }));
        expect(live.index).toBe(1);
    });

    it('skips user and system messages while searching', () => {
        const chat = [
            withCheckpoint(makeMessage({ scId: 'a1' }), auditedState({ turn_count: 1 })),
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a2' }),
            makeMessage({ isSystem: true, scId: 's1' }),
            withCheckpoint(makeMessage({ scId: 'a3' }), auditedState({ turn_count: 3 })),
            makeMessage({ isUser: true, scId: 'u2' }),
        ];

        expect(findLiveCheckpoint(chat).index).toBe(4);
    });

    it('skips a non-object payload and falls back to an older one', () => {
        const chat = [
            withCheckpoint(makeMessage({ scId: 'a1' }), auditedState({ turn_count: 1 })),
            withCheckpoint(makeMessage({ scId: 'a2' }), 7),
        ];

        const live = findLiveCheckpoint(chat);

        expect(live.state).toEqual(auditedState({ turn_count: 1 }));
        expect(live.index).toBe(0);
    });
});

describe('continuity state log defaults', () => {
    it('defaults both continuity state log flags to false', () => {
        expect(defaultSettings.continuityStateLogMode).toBe(false);
        expect(defaultSettings.continuityStateLogFullMode).toBe(false);
    });
});
