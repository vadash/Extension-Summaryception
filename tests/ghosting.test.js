import { describe, expect, it } from 'vitest';

import { repairMissingGhostingForSummaries } from '../src/core/ghosting-reconcile.js';
import { ghostMessagesInRange, unghostAllMessages } from '../src/core/ghosting.js';
import { setNotifyAdapter } from '../src/core/notify.js';
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
            // No text: an image or tool-call message that carries no summary text.
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

    /** Collect /hide commands and return a predicate testing index coverage. */
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
        await repairMissingGhostingForSummaries();
        return calls;
    }

    /** True when one of the /hide ranges contains the index. */
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

        await repairMissingGhostingForSummaries();

        expect(calls).toEqual(['/hide 1-5', '/hide 7-10']);
    });
});

/**
 * Ghosting reports its hide/unhide lifecycle through the notify adapter
 * (ADR-0004). Tests assert the structured events, never toast text.
 */
describe('ghosting notify adapter events', () => {
    it('emits structured hide progress events for manual range ghosting', async () => {
        resetCommitStateForTests();
        const recorder = makeNotifyRecorder();
        setNotifyAdapter(recorder);
        installSummaryContext({ chat: makeMessages(4) });

        await ghostMessagesInRange(0, 3, { showProgress: true });

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

    it('emits no progress events for background ghosting', async () => {
        resetCommitStateForTests();
        const recorder = makeNotifyRecorder();
        setNotifyAdapter(recorder);
        installSummaryContext({ chat: makeMessages(4) });

        await ghostMessagesInRange(0, 3);

        expect(recorder.events.filter((event) => event.type === 'progress')).toHaveLength(0);
        expect(recorder.events.filter((event) => event.type === 'update')).toHaveLength(0);
        expect(recorder.events.filter((event) => event.type === 'clear')).toHaveLength(0);
    });

    it('emits unhide progress events per range without core-side throttling', async () => {
        resetCommitStateForTests();
        const recorder = makeNotifyRecorder();
        setNotifyAdapter(recorder);
        const chat = [
            makeMessage({ scId: 'message-0', isHidden: true }),
            makeMessage({ scId: 'message-1' }),
            makeMessage({ scId: 'message-2', isHidden: true }),
        ];
        installSummaryContext({
            chat,
            metadata: {
                summaryception: makeSummaryStore({ ghostedMessageIds: ['message-0', 'message-2'] }),
            },
        });

        await unghostAllMessages();

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('ghost-unhide');
        expect(progress[0].total).toBe(2);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1, 2]);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
    });
});
