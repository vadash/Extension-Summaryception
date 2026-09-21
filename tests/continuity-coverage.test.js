import { describe, expect, it } from 'vitest';
import { deriveContinuityCoverage } from '../src/core/continuity-coverage.js';
import { makeMessage } from './test-helpers.js';

/**
 * Continuity Coverage: the chat read model shared by the audit lifecycle and
 * the Continuity Block injection. Chat facts only; the state schema and the
 * flags rulebook live in continuity-state.js.
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
