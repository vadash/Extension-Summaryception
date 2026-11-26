import { describe, expect, it } from 'vitest';

import { getChatStore } from '../src/foundation/chat-store.js';
import { ensureChatScIds } from '../src/foundation/message-identity.js';
import { getPreservationEligibility } from '../src/core/preserved-messages.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

function preserved(id, overrides = {}) {
    return { id, text: `Approved ${id}`, handedOff: false, ...overrides };
}

describe('Preserved Message Chat Store state', () => {
    it('defaults to an empty preserved collection', () => {
        installSummaryContext();

        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('normalizes valid records, drops malformed records, and keeps the first duplicate', () => {
        installSummaryContext({
            chat: [makeMessage({ scId: 'a' }), makeMessage({ scId: 'b' })],
            metadata: {
                summaryception: makeSummaryStore({
                    preservedMessages: [
                        preserved('a', { currentDateTime: '2024-07-04 16 Thu' }),
                        preserved('a', { text: 'duplicate' }),
                        preserved('b', { handedOff: true }),
                        { id: 'missing-text', handedOff: false },
                        { id: 'bad-handoff', text: 'text', handedOff: 'yes' },
                        null,
                    ],
                }),
            },
        });

        const store = getChatStore();

        expect(store.preservedMessages).toEqual([
            preserved('a', { currentDateTime: '2024-07-04 16 Thu' }),
            preserved('b', { handedOff: true }),
        ]);
        expect(Object.isFrozen(store.preservedMessages[0])).toBe(true);
        expect(Object.isFrozen(store.preservedMessages[1])).toBe(true);
    });

    it('repairs duplicate message identities before preservation resolves them', () => {
        const first = makeMessage({ scId: 'duplicate' });
        const second = makeMessage({ scId: 'duplicate' });
        const third = makeMessage({ scId: 'duplicate' });
        const chat = [first, second, third];

        expect(ensureChatScIds(chat)).toBe(true);
        expect(first.sc_id).toBe('duplicate');
        expect(second.sc_id).not.toBe('duplicate');
        expect(third.sc_id).not.toBe('duplicate');
        expect(second.sc_id).not.toBe(third.sc_id);
        expect(ensureChatScIds(chat)).toBe(false);
    });
});

describe('Preserved Message eligibility', () => {
    it('rejects hidden, summarized, system, and already preserved messages', () => {
        const hidden = makeMessage({ scId: 'hidden', isHidden: true });
        const summarized = makeMessage({ scId: 'summarized' });
        const system = makeMessage({ scId: 'system', isSystem: true });
        const tool = { ...makeMessage({ scId: 'tool' }), extra: { type: 'tool' } };
        const kept = makeMessage({ scId: 'kept' });
        const chat = [summarized, hidden, system, tool, kept];
        const store = makeSummaryStore({
            layers: [[{ text: 'old', sourceMessageIds: ['summarized'] }]],
            preservedMessages: [preserved('kept')],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });

        expect(getPreservationEligibility(hidden, chat, store).reason).toBe('hidden');
        expect(getPreservationEligibility(summarized, chat, store).reason).toBe('summarized');
        expect(getPreservationEligibility(system, chat, store).reason).toBe('system');
        expect(getPreservationEligibility(tool, chat, store).reason).toBe('system');
        expect(getPreservationEligibility(kept, chat, store).reason).toBe('preserved');
    });
});
