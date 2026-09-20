import { describe, expect, it } from 'vitest';

import {
    clearAllGhosting,
    countGhostedMessages,
    ghostMessagesInRange,
    syncGhosting,
} from '../src/core/ghosting.js';
import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import {
    makeMessage,
    makeMessages,
    makeNotifyRecorder,
    makeSummaryStore,
    installSummaryContext,
} from './test-helpers.js';

/**
 * Gap-hide contract: text-less messages inside the summarized range (images,
 * tool calls) must be hidden together with the text around them, so the model
 * does not see a perforated range that still costs context. On by default,
 * off by setting.
 */
describe('hide non-text messages in summarized range', () => {
    function buildChat() {
        return [
            makeMessage({ mes: 'turn zero', scId: 'message-0' }),
            makeMessage({ mes: 'turn one', scId: 'message-1' }),
            // Stands in for an image or tool-call message, which carries no summary text.
            makeMessage({ mes: '', name: 'Image', scId: 'message-2' }),
            makeMessage({ mes: 'turn three', scId: 'message-3' }),
        ];
    }

    function makeSummarydStore() {
        return makeSummaryStore({
            ghostedMessageIds: [],
            layers: [
                [
                    {
                        text: 'summary snippet',
                        sourceMessageIds: ['message-0', 'message-1', 'message-2', 'message-3'],
                    },
                ],
            ],
        });
    }

    async function runWith({ hideNonTextMessages }) {
        resetCommitStateForTests();
        const calls = [];
        installSummaryContext({
            chat: buildChat(),
            metadata: { summaryception: makeSummarydStore() },
            settings: { hideNonTextMessages },
            executeSlashCommandsWithOptions: async (command) => {
                calls.push(String(command));
            },
        });
        await syncGhosting();
        return calls;
    }

    function isHidden(calls, index) {
        return calls.some((cmd) => {
            if (!cmd.startsWith('/hide')) {
                return false;
            }
            const spec = cmd.slice('/hide '.length).trim();
            const dash = spec.indexOf('-');
            const lo = Number(dash < 0 ? spec : spec.slice(0, dash));
            const hi = Number(dash < 0 ? spec : spec.slice(dash + 1));
            return index >= lo && index <= hi && !Number.isNaN(lo) && !Number.isNaN(hi);
        });
    }

    it('hides text-less messages alongside the text around them', async () => {
        const calls = await runWith({ hideNonTextMessages: true });
        expect(isHidden(calls, 0)).toBe(true);
        expect(isHidden(calls, 1)).toBe(true);
        expect(isHidden(calls, 2)).toBe(true);
        expect(isHidden(calls, 3)).toBe(true);
    });

    it('skips text-less messages when the setting is disabled', async () => {
        const calls = await runWith({ hideNonTextMessages: false });
        expect(isHidden(calls, 2)).toBe(false);
        expect(isHidden(calls, 0)).toBe(true);
        expect(isHidden(calls, 1)).toBe(true);
        expect(isHidden(calls, 3)).toBe(true);
    });

    it('repairs only contiguous surviving UUID ranges and ignores a missing ID', async () => {
        resetCommitStateForTests();
        const calls = [];
        const chat = Array.from({ length: 11 }, (_value, index) =>
            makeMessage({ mes: `turn ${index}`, scId: `message-${index}` }),
        );
        installSummaryContext({
            chat,
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: 'summary snippet',
                                sourceMessageIds: [
                                    ...Array.from(
                                        { length: 5 },
                                        (_value, index) => `message-${index + 1}`,
                                    ),
                                    'missing-message',
                                    ...Array.from(
                                        { length: 4 },
                                        (_value, index) => `message-${index + 7}`,
                                    ),
                                ],
                            },
                        ],
                    ],
                }),
            },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
        });

        await syncGhosting();

        expect(calls).toEqual(['/hide 1-5', '/hide 7-10']);
    });
});

/**
 * Ghosting reports its hide/unhide lifecycle through the notify adapter
 * (ADR-0019). Tests assert the structured events, never toast text.
 */
describe('ghosting notify adapter events', () => {
    it('emits structured hide progress events for manual range ghosting', async () => {
        resetCommitStateForTests();
        const recorder = makeNotifyRecorder();
        installSummaryContext({ chat: makeMessages(4) });

        await ghostMessagesInRange(0, 3, { showProgress: true, notify: recorder });

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('ghost-hide');
        expect(progress[0].total).toBe(4);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([4]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
    });

    it('opens no progress handle for background ghosting even with an injected adapter', async () => {
        resetCommitStateForTests();
        const recorder = makeNotifyRecorder();
        installSummaryContext({ chat: makeMessages(4) });

        await ghostMessagesInRange(0, 3, { notify: recorder });

        expect(recorder.events.filter((event) => event.type === 'progress')).toHaveLength(0);
        expect(recorder.events.filter((event) => event.type === 'update')).toHaveLength(0);
        expect(recorder.events.filter((event) => event.type === 'clear')).toHaveLength(0);
    });
});
/**
 * Ownership sync: the desired ghost set is every Snippet provenance id across
 * all layers. syncGhosting hides desired messages that are not covered yet and
 * releases owned messages no longer referenced by any layer, ending with
 * ownership equal to the desired set.
 */
describe('syncGhosting ownership sync', () => {
    function installWith(chat, store) {
        resetCommitStateForTests();
        const calls = [];
        const runtime = installSummaryContext({
            chat,
            metadata: { summaryception: store },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
        });
        return { calls, runtime };
    }

    it('releases owned ids no longer referenced by any layer', async () => {
        const chat = [
            makeMessage({ scId: 'message-0', isHidden: true }),
            makeMessage({ scId: 'message-1', isHidden: true }),
        ];
        const store = makeSummaryStore({
            ghostedMessageIds: ['message-0', 'message-1'],
            layers: [[{ text: 'summary', sourceMessageIds: ['message-0'] }]],
        });
        const { calls, runtime } = installWith(chat, store);

        const outcome = await syncGhosting();

        expect(calls).toEqual(['/unhide 1']);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual(['message-0']);
        expect(outcome).toEqual({ hidden: 0, unhidden: 1 });
    });

    it('hides missing desired messages and reports both direction counts', async () => {
        const chat = [
            makeMessage({ scId: 'message-0', isHidden: true }),
            makeMessage({ scId: 'message-1', isHidden: true }),
            makeMessage({ scId: 'message-2', isHidden: true }),
            makeMessage({ scId: 'message-3' }),
        ];
        const store = makeSummaryStore({
            ghostedMessageIds: ['message-0', 'message-1', 'message-2'],
            layers: [
                [{ text: 'summary', sourceMessageIds: ['message-0', 'message-1', 'message-3'] }],
            ],
        });
        const { calls, runtime } = installWith(chat, store);

        const outcome = await syncGhosting();

        expect(calls).toEqual(['/unhide 2', '/hide 3']);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([
            'message-0',
            'message-1',
            'message-3',
        ]);
        expect(outcome).toEqual({ hidden: 1, unhidden: 1 });
    });

    it('keeps desired ids whose messages no longer resolve inert in ownership', async () => {
        const chat = [makeMessage({ scId: 'message-0', isHidden: true })];
        const store = makeSummaryStore({
            ghostedMessageIds: ['message-0', 'gone-id'],
            layers: [[{ text: 'summary', sourceMessageIds: ['message-0', 'gone-id'] }]],
        });
        const { calls, runtime } = installWith(chat, store);

        const outcome = await syncGhosting();

        expect(calls).toEqual([]);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([
            'message-0',
            'gone-id',
        ]);
        expect(outcome).toEqual({ hidden: 0, unhidden: 0 });
    });

    it('emits no notify events for a background sync with nothing to do', async () => {
        const recorder = makeNotifyRecorder();
        resetCommitStateForTests();
        installSummaryContext({
            chat: [makeMessage({ scId: 'message-0', isHidden: true })],
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0'],
                    layers: [[{ text: 'summary', sourceMessageIds: ['message-0'] }]],
                }),
            },
        });

        await syncGhosting({ notify: recorder });

        expect(recorder.events).toEqual([]);
    });
});
/**
 * Ghost ownership clearing and counting live beside the Ghosting engine so
 * every call site reads ownership through one module.
 */
describe('clearAllGhosting', () => {
    it('unhides the full chat range and wipes ownership', async () => {
        resetCommitStateForTests();
        const calls = [];
        const runtime = installSummaryContext({
            chat: makeMessages(3),
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0', 'message-2'],
                    layers: [[{ text: 'summary', sourceMessageIds: ['message-0'] }]],
                }),
            },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
        });

        await clearAllGhosting();

        expect(calls).toEqual(['/unhide 0-2']);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([]);
    });

    it('skips the slash command for an empty chat but still wipes ownership', async () => {
        resetCommitStateForTests();
        const calls = [];
        const runtime = installSummaryContext({
            chat: [],
            metadata: {
                summaryception: makeSummaryStore({ ghostedMessageIds: ['gone-id'] }),
            },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
        });

        await clearAllGhosting();

        expect(calls).toEqual([]);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([]);
    });
});

describe('countGhostedMessages', () => {
    it('counts owned ids that still resolve in the chat', () => {
        resetCommitStateForTests();
        installSummaryContext({
            chat: makeMessages(3),
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0', 'message-2', 'gone-id'],
                }),
            },
        });

        expect(countGhostedMessages()).toBe(2);
    });

    it('returns 0 when no chat context is installed', () => {
        const stub = globalThis.SillyTavern;
        delete globalThis.SillyTavern;
        try {
            expect(countGhostedMessages()).toBe(0);
        } finally {
            globalThis.SillyTavern = stub;
        }
    });
});

/**
 * Ghosting owns its ownership-array mutation epoch bump: any ownership change
 * bumps, an assignment that changes nothing must not (ADR-0003).
 */
describe('ghosting mutation epoch', () => {
    it('bumps the epoch when ownership sync picks up changed provenance', async () => {
        resetCommitStateForTests();
        const runtime = installSummaryContext({
            chat: [makeMessage({ scId: 'message-0', isHidden: true })],
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0'],
                    mutationEpoch: 2,
                    layers: [[{ text: 'summary', sourceMessageIds: ['message-0', 'gone-id'] }]],
                }),
            },
        });

        await syncGhosting();

        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([
            'message-0',
            'gone-id',
        ]);
        expect(runtime.chatMetadata.summaryception.mutationEpoch).toBe(3);
    });

    it('does not bump the epoch when ownership already matches provenance', async () => {
        resetCommitStateForTests();
        const runtime = installSummaryContext({
            chat: [makeMessage({ scId: 'message-0', isHidden: true })],
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0'],
                    mutationEpoch: 2,
                    layers: [[{ text: 'summary', sourceMessageIds: ['message-0'] }]],
                }),
            },
        });

        await syncGhosting();

        expect(runtime.chatMetadata.summaryception.mutationEpoch).toBe(2);
    });

    it('bumps the epoch when range ghosting takes ownership', async () => {
        resetCommitStateForTests();
        const runtime = installSummaryContext({ chat: makeMessages(2) });

        await ghostMessagesInRange(0, 1);

        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([
            'message-0',
            'message-1',
        ]);
        expect(runtime.chatMetadata.summaryception.mutationEpoch).toBe(1);
    });

    it('bumps the epoch when clearing releases owned ids', async () => {
        resetCommitStateForTests();
        const runtime = installSummaryContext({
            chat: makeMessages(1),
            metadata: {
                summaryception: makeSummaryStore({
                    ghostedMessageIds: ['message-0'],
                    mutationEpoch: 2,
                }),
            },
        });

        await clearAllGhosting();

        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([]);
        expect(runtime.chatMetadata.summaryception.mutationEpoch).toBe(3);
    });

    it('does not bump the epoch when clearing an already-empty ownership list', async () => {
        resetCommitStateForTests();
        const runtime = installSummaryContext({
            chat: makeMessages(1),
            metadata: { summaryception: makeSummaryStore({ mutationEpoch: 2 }) },
        });

        await clearAllGhosting();

        expect(runtime.chatMetadata.summaryception.mutationEpoch).toBe(2);
    });
});
