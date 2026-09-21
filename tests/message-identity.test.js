import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createUuid,
    ensureChatScIds,
    ensureMessageScId,
    getMessageIndexByScId,
    rangesFromSortedIndices,
    removeMessageIdentities,
    resolveScIdsToIndices,
} from '../src/foundation/message-identity.js';
import { makeMessage } from './test-helpers.js';

describe('message identity', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('assigns missing IDs and preserves top-level identity across extra replacement', () => {
        vi.spyOn(globalThis.crypto, 'randomUUID')
            .mockReturnValueOnce('message-1')
            .mockReturnValueOnce('message-2');
        const first = makeMessage({ scId: undefined });
        const second = makeMessage({ scId: '' });
        const chat = [first, second, null];

        expect(ensureChatScIds(chat)).toBe(true);
        expect(first.sc_id).toBe('message-1');
        expect(second.sc_id).toBe('message-2');

        first.extra = { replacedBySwipe: true };
        expect(ensureMessageScId(first)).toBe('message-1');
        expect(ensureChatScIds(chat)).toBe(false);
    });

    it('keeps the first duplicate ID and resolves unique current indices in order', () => {
        const chat = [
            makeMessage({ scId: 'duplicate' }),
            makeMessage({ scId: 'message-1' }),
            makeMessage({ scId: 'duplicate' }),
            makeMessage({ scId: 'message-3' }),
        ];

        expect(getMessageIndexByScId(chat)).toEqual(
            new Map([
                ['duplicate', 0],
                ['message-1', 1],
                ['message-3', 3],
            ]),
        );
        expect(
            resolveScIdsToIndices(chat, ['message-3', 'missing', 'duplicate', 'message-3']),
        ).toEqual([0, 3]);
        expect(rangesFromSortedIndices([0, 1, 3])).toEqual([
            [0, 1],
            [3, 3],
        ]);
    });

    it('ignores non-message inputs', () => {
        expect(ensureMessageScId(null)).toBeNull();
        expect(ensureMessageScId([])).toBeNull();
        expect(ensureChatScIds('not-chat')).toBe(false);
    });

    it('prefers native crypto.randomUUID through createUuid', () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('native-uuid');

        expect(createUuid()).toBe('native-uuid');
    });

    it('falls back to distinct v4 UUIDs when crypto.randomUUID is unavailable', () => {
        const nativeRandomUUID = globalThis.crypto.randomUUID;
        globalThis.crypto.randomUUID = undefined;
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        try {
            const first = ensureMessageScId(makeMessage({ scId: undefined }));
            const second = ensureMessageScId(makeMessage({ scId: '' }));

            expect(first).toMatch(uuidPattern);
            expect(second).toMatch(uuidPattern);
            expect(first).not.toBe(second);
        } finally {
            globalThis.crypto.randomUUID = nativeRandomUUID;
        }
    });
});

describe('removeMessageIdentities', () => {
    it('drops the identifier from every message and ignores non-messages', () => {
        const chat = [
            makeMessage({ scId: 'message-1' }),
            null,
            makeMessage({ scId: 'message-2' }),
            'not-a-message',
        ];

        removeMessageIdentities(chat);

        expect(Object.hasOwn(chat[0], 'sc_id')).toBe(false);
        expect(Object.hasOwn(chat[2], 'sc_id')).toBe(false);
        expect(() => removeMessageIdentities('not-chat')).not.toThrow();
    });

    it('leaves a wiped chat ready for reconciliation to re-mint identifiers', () => {
        const chat = [makeMessage({ scId: 'message-1' })];
        removeMessageIdentities(chat);

        expect(ensureChatScIds(chat)).toBe(true);
        expect(typeof chat[0].sc_id).toBe('string');
    });
});
