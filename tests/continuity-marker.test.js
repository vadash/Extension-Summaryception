import { describe, expect, it } from 'vitest';
import { deriveContinuityMarks } from '../src/entry/continuity-marker.js';
import { makeMessage } from './test-helpers.js';

function audited(message) {
    message.extra.summaryception_continuity = { turn_count: 1 };
    return message;
}

describe('deriveContinuityMarks', () => {
    it('returns no marks for an empty chat', () => {
        expect(deriveContinuityMarks([])).toEqual({ markedIndices: [], liveIndex: null });
    });

    it('marks assistant replies carrying a checkpoint payload and puts the live mark on the newest one', () => {
        const chat = [
            makeMessage({ isUser: true }),
            audited(makeMessage()),
            makeMessage({ isUser: true }),
            makeMessage(),
            audited(makeMessage()),
        ];
        expect(deriveContinuityMarks(chat)).toEqual({ markedIndices: [1, 4], liveIndex: 4 });
    });

    it('skips user and system messages even when they carry a payload', () => {
        const chat = [
            audited(makeMessage({ isUser: true })),
            audited(makeMessage({ isSystem: true })),
        ];
        expect(deriveContinuityMarks(chat)).toEqual({ markedIndices: [], liveIndex: null });
    });

    it('leaves replies without a payload unmarked', () => {
        const chat = [makeMessage(), makeMessage()];
        expect(deriveContinuityMarks(chat)).toEqual({ markedIndices: [], liveIndex: null });
    });
});
