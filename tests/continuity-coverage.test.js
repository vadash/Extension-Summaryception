import { describe, expect, it } from 'vitest';

import {
    deriveContinuityCoverage,
    deriveContinuityMarks,
} from '../src/core/continuity-coverage.js';
import { diffContinuityStates } from '../src/core/continuity-diff.js';
import { deriveTurnCount } from '../src/core/continuity-state.js';
import { formatContinuityBlock } from '../src/features/continuity-injection.js';
import { makeMessage } from './test-helpers.js';
import {
    CHAT_SHAPE,
    CHECKPOINT_GAPS,
    CHECKPOINT_LEDGER,
    GHOSTED_RANGE,
    NPC_NAME,
    PAIR_KEY,
    buildGhostedChat,
} from './fixtures/ghosted-continuity-chat.js';

/**
 * Continuity Coverage: the chat read model shared by the audit lifecycle and
 * the Continuity Block injection. Chat facts only; the state schema and the
 * flags rulebook are the continuity state module's job.
 */

const auditedState = (turnCount, overrides = {}) => ({
    turn_count: turnCount,
    bonds: { 'Quipsy↔User': { bond: turnCount, sparks: 0, grudge: 0 } },
    agendas: {},
    gm_notes: [],
    physics: {
        location: '',
        environment: '',
        posture_and_position: '',
        contact_points: '',
        clothing_state: '',
    },
    ...overrides,
});

const withCheckpoint = (message, state) => {
    message.extra.summaryception_continuity = state;
    return message;
};

const user = (scId) => makeMessage({ isUser: true, scId });
const reply = (scId) => makeMessage({ scId });

describe('deriveContinuityCoverage', () => {
    it('anchors on the newest checkpoint and lists the un-audited replies after it', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), auditedState(1)),
            user('u2'),
            reply('a2'),
            user('u3'),
            reply('a3'),
        ];

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(1);
        expect(coverage.state).toEqual(auditedState(1));
        expect(coverage.unauditedIndices).toEqual([3, 5]);
        expect(coverage.targetIndex).toBe(5);
        expect(coverage.turnCount).toBe(3);
        expect(coverage.stale).toBe(true);
    });

    it('reports no checkpoint, no staleness, and the whole chat as the audit target', () => {
        const coverage = deriveContinuityCoverage([
            user('u1'),
            reply('a1'),
            user('u2'),
            reply('a2'),
        ]);

        expect(coverage.checkpointIndex).toBe(null);
        expect(coverage.state).toBe(null);
        expect(coverage.stale).toBe(false);
        expect(coverage.unauditedIndices).toEqual([1, 3]);
        expect(coverage.targetIndex).toBe(3);
        expect(coverage.turnCount).toBe(2);
    });

    it('is not stale while the checkpoint covers the newest reply', () => {
        const chat = [
            user('u1'),
            reply('a1'),
            user('u2'),
            withCheckpoint(reply('a2'), auditedState(2)),
        ];

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(3);
        expect(coverage.unauditedIndices).toEqual([]);
        expect(coverage.targetIndex).toBe(null);
        expect(coverage.stale).toBe(false);
    });

    it('bounds the audit window to the last four un-audited Exchanges, user turns included', () => {
        const chat = [withCheckpoint(reply('a0'), auditedState(0))];
        for (let turn = 1; turn <= 6; turn++) {
            chat.push(user(`u${turn}`), reply(`a${turn}`));
        }

        const { windowIndices } = deriveContinuityCoverage(chat);

        expect(windowIndices).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('keeps the Exchange user line when a system message sits before the reply', () => {
        const chat = [
            withCheckpoint(reply('a0'), auditedState(0)),
            user('u1'),
            makeMessage({ isSystem: true, scId: 's1' }),
            reply('a1'),
        ];

        const { windowIndices, targetIndex } = deriveContinuityCoverage(chat);

        // The user line the walk back crosses still rides along, and the system
        // message is a non-user message, so it joins the window too (ADR-0028).
        expect(windowIndices).toEqual([1, 2, 3]);
        expect(targetIndex).toBe(3);
    });

    it('covers the whole chat when no checkpoint anchors coverage', () => {
        const chat = [user('u1'), reply('a1'), user('u2'), reply('a2')];

        expect(deriveContinuityCoverage(chat).windowIndices).toEqual([0, 1, 2, 3]);
    });

    it('keeps newest-wins while walking past user, system, and non-object payloads', () => {
        const chat = [
            withCheckpoint(reply('a1'), auditedState(1)),
            withCheckpoint(reply('a2'), 7),
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ isSystem: true, scId: 's1' }),
            withCheckpoint(reply('a3'), auditedState(3)),
            user('u2'),
        ];

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(4);
        expect(coverage.state).toEqual(auditedState(3));
        // Three replies plus the system message, which is not the user turn.
        expect(coverage.turnCount).toBe(4);
    });

    it('falls back to an older payload when the newest one is not a state object', () => {
        const chat = [withCheckpoint(reply('a1'), auditedState(1)), withCheckpoint(reply('a2'), 7)];

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(0);
        expect(coverage.state).toEqual(auditedState(1));
    });

    it('places the block one message past the last covered reply', () => {
        const settled = [
            user('u1'),
            reply('a1'),
            user('u2'),
            withCheckpoint(reply('a2'), auditedState(2)),
        ];
        const drifted = [
            user('u1'),
            withCheckpoint(reply('a1'), auditedState(1)),
            user('u2'),
            reply('a2'),
            user('u3'),
            reply('a3'),
        ];

        expect(deriveContinuityCoverage(settled).blockDepth).toBe(1);
        expect(deriveContinuityCoverage(drifted).blockDepth).toBe(3);
    });
});

describe('reroll tail', () => {
    it('takes the prompt view: the excluded tail is never the live checkpoint', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), auditedState(1)),
            user('u2'),
            withCheckpoint(reply('a2'), auditedState(2)),
        ];

        const coverage = deriveContinuityCoverage(chat, { rerollTail: true });

        expect(coverage.checkpointIndex).toBe(1);
        expect(coverage.state).toEqual(auditedState(1));
        expect(coverage.unauditedIndices).toEqual([3]);
        expect(coverage.stale).toBe(true);
        expect(coverage.blockDepth).toBe(1);
    });

    it('counts the tail again once the reroll is over', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), auditedState(1)),
            user('u2'),
            reply('a2'),
        ];

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.blockDepth).toBe(2);
        expect(coverage.stale).toBe(true);
    });
});

describe('Continuity Marks', () => {
    it('marks payload-carrying replies and puts the Live Mark on the newest one', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), auditedState(1)),
            user('u2'),
            reply('a2'),
            withCheckpoint(reply('a3'), auditedState(2)),
        ];

        expect(deriveContinuityMarks(chat)).toEqual({ markedIndices: [1, 4], liveIndex: 4 });
    });

    it('skips the user turn and marks a hidden reply', () => {
        const chat = [
            withCheckpoint(makeMessage({ isUser: true }), auditedState(1)),
            withCheckpoint(makeMessage({ isSystem: true }), auditedState(1)),
        ];

        // The user turn never carries a mark; a hidden reply is still a reply,
        // and Ghosting's hide flag is not its identity (ADR-0028).
        expect(deriveContinuityMarks(chat)).toEqual({ markedIndices: [1], liveIndex: 1 });
    });

    it('returns no marks when no reply carries a payload', () => {
        expect(deriveContinuityMarks([])).toEqual({ markedIndices: [], liveIndex: null });
        expect(deriveContinuityMarks([makeMessage(), makeMessage()])).toEqual({
            markedIndices: [],
            liveIndex: null,
        });
    });
});

/**
 * A chat the Summarizer has ghosted most of still counts every Exchange
 * (ADR-0028): prompt visibility is not part of a reply's identity, so the Turn
 * Count, the coverage anchor, and the Continuity Marks all read the chat.
 */
describe('ghosted projection', () => {
    const chat = buildGhostedChat();

    it('reproduces the export shape and the ledger payload gaps', () => {
        expect(chat).toHaveLength(CHAT_SHAPE.messages);
        expect(chat.filter((message) => message.is_user)).toHaveLength(CHAT_SHAPE.userMessages);

        const ghostedIndices = chat.flatMap((message, index) => (message.is_system ? [index] : []));
        expect(ghostedIndices).toHaveLength(CHAT_SHAPE.ghostedMessages);
        expect(ghostedIndices[0]).toBe(GHOSTED_RANGE[0]);
        expect(ghostedIndices[ghostedIndices.length - 1]).toBe(GHOSTED_RANGE[1]);

        const gaps = chat.flatMap((message, index) =>
            !message.is_user && message.extra.summaryception_continuity === undefined
                ? [index]
                : [],
        );
        expect(gaps).toEqual([...CHECKPOINT_GAPS]);
    });

    it('counts every Exchange and anchors coverage on the newest checkpoint, hidden or not', () => {
        expect(deriveTurnCount(chat)).toBe(CHAT_SHAPE.assistantMessages);

        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(118);
        expect(coverage.turnCount).toBe(CHAT_SHAPE.assistantMessages);
        expect(coverage.unauditedIndices).toEqual([120]);
        expect(coverage.targetIndex).toBe(120);
        expect(coverage.windowIndices).toEqual([119, 120]);
        expect(coverage.stale).toBe(true);
        expect(coverage.blockDepth).toBe(2);

        const marks = deriveContinuityMarks(chat);

        expect(marks.markedIndices).toEqual(CHECKPOINT_LEDGER.map(([index]) => index));
        expect(marks.liveIndex).toBe(118);
    });

    it('keeps the sawtooth Turn Count and renders a retired-agenda checkpoint', () => {
        expect(chat[32].extra.summaryception_continuity.turn_count).toBe(17);
        expect(chat[36].extra.summaryception_continuity.turn_count).toBe(8);
        expect(chat[118].extra.summaryception_continuity.turn_count).toBe(14);

        const block = formatContinuityBlock(chat[2].extra.summaryception_continuity);

        expect(block).toContain('[SCENE & POSITIONING]');
        expect(block).toContain('[RELATIONSHIP GATES]');
        expect(block).toContain('[SECRETS & ASYMMETRIC KNOWLEDGE]');
        expect(block).toContain('[ACTIVE AGENDAS & THREADS]');
        expect(block).toContain(PAIR_KEY);
        expect(block).toContain(NPC_NAME);
        expect(block).not.toContain('retired field');
    });
});

describe('Continuity Diff', () => {
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

    it('reports changed scalar, bond, and physics fields as old->new pairs', () => {
        const prior = fullState();
        const next = fullState({
            turn_count: 3,
            bonds: { 'Quipsy↔User': { bond: 12, sparks: 6, grudge: 1 } },
            physics: { ...fullState().physics, location: 'Kitchen' },
        });

        expect(diffContinuityStates(prior, next)).toEqual({
            turn_count: [2, 3],
            bonds: { 'Quipsy↔User': { bond: [10, 12] } },
            physics: { location: ['Salon', 'Kitchen'] },
        });
    });

    it('reports added gm notes', () => {
        const prior = fullState({ gm_notes: ['[R] Vova watches.'] });
        const next = fullState({ gm_notes: ['[T] Quipsy knows.', '[R] Vova watches.'] });

        expect(diffContinuityStates(prior, next)).toEqual({
            gm_notes: { added: ['[T] Quipsy knows.'] },
        });
    });

    it('reports sections in schema order and nothing for identical states', () => {
        const next = fullState({
            turn_count: 3,
            bonds: { 'Quipsy↔User': { bond: 12, sparks: 6, grudge: 1 } },
            gm_notes: ['[R] Vova watches.'],
            physics: { ...fullState().physics, location: 'Kitchen' },
        });
        const diff = diffContinuityStates(fullState(), next);

        expect(Object.keys(diff)).toEqual(['turn_count', 'bonds', 'gm_notes', 'physics']);
        expect(diffContinuityStates(fullState(), fullState())).toEqual({});
    });
});
