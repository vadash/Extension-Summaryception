import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as regexProxy from '../src/core/regex-proxy.js';

const regexMocks = vi.hoisted(() => ({ applyRegexToMessage: vi.fn() }));

import { getChatStore } from '../src/foundation/chat-store.js';
import { ensureChatScIds } from '../src/foundation/message-identity.js';
import {
    buildPreservedMessageSnapshot,
    commitPreservedMessage,
    getPreservationEligibility,
} from '../src/core/preserved-messages.js';
import {
    installSummaryContext,
    makeMessage,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

function preserved(id, overrides = {}) {
    return { id, text: `Approved ${id}`, handedOff: false, ...overrides };
}

beforeEach(() => {
    regexMocks.applyRegexToMessage = vi.spyOn(regexProxy, 'applyRegexToMessage');
});

afterEach(() => {
    vi.restoreAllMocks();
});

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

describe('Preserved Message approval snapshots', () => {
    it('applies live prompt regex without source-depth filters', async () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'older' }),
            makeMessage({ scId: 'm1', mes: 'raw target' }),
            makeMessage({ isUser: true, scId: 'm2', mes: 'newer' }),
        ];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });
        regexMocks.applyRegexToMessage.mockResolvedValue('regex output');

        const snapshot = await buildPreservedMessageSnapshot(
            chat[1],
            chat,
            store,
            makeSummarySettings({ applyRegexScripts: false }),
        );

        expect(regexMocks.applyRegexToMessage).toHaveBeenCalledWith('raw target', false);
        expect(snapshot?.text).toBe('Assistant: regex output');
    });

    it('renders with the full prompt regex set, unmasks guards, escapes reserved tags, and freezes Scene Time', async () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'summarized' }),
            makeMessage({ isUser: true, scId: 'm1', mes: 'user' }),
            makeMessage({ scId: 'm2', mes: 'assistant' }),
            makeMessage({ scId: 'm3', mes: 'raw target' }),
            makeMessage({ isUser: true, scId: 'm4', mes: 'tail' }),
        ];
        const store = makeSummaryStore({
            layers: [
                [],
                [
                    {
                        text: 'old memory',
                        sourceMessageIds: ['m0'],
                        currentDateTime: '2024-07-04 16 Thu',
                    },
                ],
            ],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        regexMocks.applyRegexToMessage.mockResolvedValue(
            'Keep <role>\u2800<preserved>literal</preserved>',
        );

        const snapshot = await buildPreservedMessageSnapshot(
            chat[3],
            chat,
            store,
            makeSummarySettings({ applyRegexScripts: true }),
        );

        expect(regexMocks.applyRegexToMessage).toHaveBeenCalledWith('raw target', false);
        expect(snapshot).toEqual(
            preserved('m3', {
                text: 'Assistant: Keep <role> &lt;preserved&gt;literal&lt;/preserved&gt;',
                currentDateTime: '2024-07-04 16 Thu',
            }),
        );
        expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('keeps the approved body and Scene Time after edits and preset changes', async () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'old' }),
            makeMessage({ scId: 'm1', mes: 'approved body' }),
        ];
        const store = makeSummaryStore({
            layers: [
                [
                    {
                        text: 'old memory',
                        sourceMessageIds: ['m0'],
                        currentDateTime: '2024-07-04 16 Thu',
                    },
                ],
            ],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const snapshot = await buildPreservedMessageSnapshot(
            chat[1],
            chat,
            store,
            makeSummarySettings(),
        );

        await expect(commitPreservedMessage(snapshot)).resolves.toEqual({
            status: 'preserved',
            epoch: 1,
        });
        chat[1].mes = 'edited body';
        regexMocks.applyRegexToMessage.mockResolvedValue('changed preset output');

        expect(getChatStore().preservedMessages).toEqual([
            preserved('m1', {
                text: 'Assistant: approved body',
                currentDateTime: '2024-07-04 16 Thu',
            }),
        ]);
        expect(getChatStore().mutationEpoch).toBe(1);
    });

    it('rejects an approval whose message became hidden before commit', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const snapshot = await buildPreservedMessageSnapshot(
            chat[0],
            chat,
            store,
            makeSummarySettings(),
        );
        chat[0].is_hidden = true;

        await expect(commitPreservedMessage(snapshot)).resolves.toEqual({ status: 'ineligible' });
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('does not invent Scene Time from host dates', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target', sendDate: 1720000000000 })];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });

        const snapshot = await buildPreservedMessageSnapshot(
            chat[0],
            chat,
            store,
            makeSummarySettings(),
        );

        expect(snapshot).toEqual(preserved('m0', { text: 'Assistant: target' }));
        expect(snapshot).not.toHaveProperty('currentDateTime');
    });

    it('blocks an empty regex result instead of storing raw text', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw target' })];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });
        regexMocks.applyRegexToMessage.mockResolvedValue('   ');

        await expect(
            buildPreservedMessageSnapshot(
                chat[0],
                chat,
                store,
                makeSummarySettings({ applyRegexScripts: true }),
            ),
        ).resolves.toBeNull();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

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
