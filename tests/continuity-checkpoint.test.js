import { describe, expect, it } from 'vitest';

import {
    attachCheckpoint,
    discardCheckpoint,
    findLiveCheckpoint,
    isRerollTail,
    listCheckpointIndices,
    removeCheckpoints,
} from '../src/core/continuity-checkpoint.js';
import { makeMessage } from './test-helpers.js';

/**
 * The Continuity Checkpoint: the payload a settled audit commits into the
 * audited reply's message extra, and the payload rules around it (ADR-0017).
 * Chat facts and payload facts only; the state schema lives in
 * continuity-state.js and the coverage read model in continuity-coverage.js.
 */

const state = (turnCount, overrides = {}) => ({
    turn_count: turnCount,
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
    ...overrides,
});

const user = (scId) => makeMessage({ isUser: true, scId });
const system = (scId) => makeMessage({ isSystem: true, scId });
const reply = (scId) => makeMessage({ scId });

const withCheckpoint = (message, payload) => {
    message.extra.summaryception_continuity = payload;
    return message;
};

describe('isRerollTail', () => {
    it('detects only the reroll types whose target is the chat tail', () => {
        const tailReply = () => [user('u1'), reply('a1')];
        const trailingUser = () => [user('u1'), reply('a1'), user('u2')];

        expect(isRerollTail('swipe', tailReply())).toBe(true);
        expect(isRerollTail('regenerate', tailReply())).toBe(true);
        expect(isRerollTail('normal', tailReply())).toBe(false);
        expect(isRerollTail('regenerate', trailingUser())).toBe(false);
        expect(isRerollTail('swipe', [])).toBe(false);
        expect(isRerollTail(undefined, tailReply())).toBe(false);
    });

    it('leaves a missing chat out of the reroll types', () => {
        expect(isRerollTail('swipe', undefined)).toBe(false);
    });
});

describe('attachCheckpoint', () => {
    it('writes the payload into the message extra and keeps unrelated extras', () => {
        const message = reply('a1');
        message.extra.reasoning = 'keep';

        attachCheckpoint(message, state(1));

        expect(message.extra).toEqual({
            reasoning: 'keep',
            summaryception_continuity: state(1),
        });
    });

    it('gives a message with no extra a fresh one', () => {
        const message = { is_user: false, mes: 'Hello, world.' };

        attachCheckpoint(message, state(1));

        expect(message.extra).toEqual({ summaryception_continuity: state(1) });
    });

    it('ignores a message object it cannot carry a payload on', () => {
        expect(() => attachCheckpoint(null, state(1))).not.toThrow();
    });
});

describe('discardCheckpoint', () => {
    it('drops the replaced reply payload and leaves older checkpoints intact', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), state(1)),
            user('u2'),
            withCheckpoint(reply('a2'), state(2)),
        ];

        expect(discardCheckpoint(chat, 'regenerate')).toBe(true);

        expect(chat[3].extra.summaryception_continuity).toBeUndefined();
        expect(chat[1].extra.summaryception_continuity).toEqual(state(1));
    });

    it('drops the payload on swipe generations the same way', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), state(1)),
            user('u2'),
            withCheckpoint(reply('a2'), state(2)),
        ];

        expect(discardCheckpoint(chat, 'swipe')).toBe(true);
        expect(chat[3].extra.summaryception_continuity).toBeUndefined();
        expect(chat[1].extra.summaryception_continuity).toEqual(state(1));
    });

    it('keeps the payload on generations that do not replace the chat tail', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), state(1)),
            user('u2'),
            withCheckpoint(reply('a2'), state(2)),
        ];

        expect(discardCheckpoint(chat, 'normal')).toBe(false);
        expect(chat[3].extra.summaryception_continuity).toEqual(state(2));
    });

    it('keeps the payload when a reroll answers a trailing user turn', () => {
        const chat = [user('u1'), withCheckpoint(reply('a1'), state(1)), user('u2')];

        expect(discardCheckpoint(chat, 'regenerate')).toBe(false);
        expect(chat[1].extra.summaryception_continuity).toEqual(state(1));
    });

    it('reports no drop when the replaced reply carries no payload', () => {
        expect(discardCheckpoint([user('u1'), reply('a1')], 'swipe')).toBe(false);
    });
});

describe('removeCheckpoints', () => {
    it('drops every checkpoint payload and keeps unrelated extras', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), state(1)),
            user('u2'),
            withCheckpoint(reply('a2'), state(2)),
        ];
        chat[0].extra.reasoning = 'keep';

        removeCheckpoints(chat);

        expect(chat[1].extra.summaryception_continuity).toBeUndefined();
        expect(chat[3].extra.summaryception_continuity).toBeUndefined();
        expect(chat[0].extra).toEqual({ reasoning: 'keep' });
    });

    it('ignores non-chat inputs', () => {
        expect(() => removeCheckpoints('not-chat')).not.toThrow();
        expect(() => removeCheckpoints(undefined)).not.toThrow();
    });
});

describe('listCheckpointIndices', () => {
    it('lists the payload-bearing replies in chat order', () => {
        const chat = [
            user('u1'),
            withCheckpoint(reply('a1'), state(1)),
            user('u2'),
            reply('a2'),
            withCheckpoint(system('s1'), state(2)),
        ];

        expect(listCheckpointIndices(chat)).toEqual([1, 4]);
    });

    it('skips payloads that are not state objects and messages that are not replies', () => {
        const chat = [
            withCheckpoint(user('u1'), state(1)),
            withCheckpoint(reply('a1'), 7),
            withCheckpoint(reply('a2'), state(2)),
        ];

        expect(listCheckpointIndices(chat)).toEqual([2]);
    });

    it('returns nothing for an empty or non-array chat', () => {
        expect(listCheckpointIndices([])).toEqual([]);
        expect(listCheckpointIndices(undefined)).toEqual([]);
    });
});

describe('findLiveCheckpoint', () => {
    it('returns the newest payload with the index that carries it', () => {
        const chat = [withCheckpoint(reply('a1'), state(1)), withCheckpoint(reply('a2'), state(2))];

        expect(findLiveCheckpoint(chat, -1)).toEqual({ state: state(2), index: 1 });
    });

    it('never anchors on the excluded prompt-view tail', () => {
        const chat = [withCheckpoint(reply('a1'), state(1)), withCheckpoint(reply('a2'), state(2))];

        expect(findLiveCheckpoint(chat, 1)).toEqual({ state: state(1), index: 0 });
    });

    it('walks past user, system, and non-object payloads', () => {
        const chat = [
            withCheckpoint(reply('a1'), state(1)),
            withCheckpoint(reply('a2'), 7),
            user('u1'),
            system('s1'),
            withCheckpoint(system('s2'), state(3)),
        ];

        expect(findLiveCheckpoint(chat, -1)).toEqual({ state: state(3), index: 4 });
    });

    it('falls back to an older payload when the newest one is not a state object', () => {
        const chat = [withCheckpoint(reply('a1'), state(1)), withCheckpoint(reply('a2'), 7)];

        expect(findLiveCheckpoint(chat, -1)).toEqual({ state: state(1), index: 0 });
    });

    it('returns null when no reply carries a payload', () => {
        expect(findLiveCheckpoint([user('u1'), reply('a1')], -1)).toBe(null);
        expect(findLiveCheckpoint(undefined, -1)).toBe(null);
    });
});
