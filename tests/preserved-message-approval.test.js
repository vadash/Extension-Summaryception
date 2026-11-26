import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as regexProxy from '../src/core/regex-proxy.js';

const regexMocks = vi.hoisted(() => ({ applyRegexToMessage: vi.fn() }));

import { getChatStore } from '../src/foundation/chat-store.js';
import { getChat, getContext } from '../src/foundation/context.js';
import { getEffectiveSettings } from '../src/foundation/settings.js';
import { getChatIdentity } from '../src/core/summarizer-snapshot.js';
import { createPreservedMessageApproval } from '../src/core/preserved-messages.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

beforeEach(() => {
    regexMocks.applyRegexToMessage = vi.spyOn(regexProxy, 'applyRegexToMessage');
    regexMocks.applyRegexToMessage.mockImplementation(async (mes) => String(mes));
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeDeps(overrides = {}) {
    return {
        getChat,
        getChatStore,
        getEffectiveSettings,
        getContext,
        getChatIdentity,
        isGenerating: () => false,
        gate: { isFrozen: () => false },
        queue: { isBusy: () => false },
        saveChatStore: async () => {},
        ...overrides,
    };
}

function approvedConfirm() {
    return {
        show: vi.fn(async ({ revision }) => ({ approved: true, revision })),
    };
}

describe('Preserved Message approval transaction', () => {
    it('commits the exact approved bytes', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });
        regexMocks.applyRegexToMessage.mockResolvedValue('approved body');
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome.status).toBe('committed');
        expect(outcome.record).toMatchObject({ id: 'm0', text: 'Assistant: approved body' });
        expect(getChatStore().preservedMessages).toEqual([
            expect.objectContaining({ id: 'm0', text: 'Assistant: approved body' }),
        ]);
        expect(getChatStore().mutationEpoch).toBe(1);
        expect(confirm.show).toHaveBeenCalledOnce();
        const shown = confirm.show.mock.calls[0][0];
        expect(shown.preview).toContain('<preserved>');
        expect(shown.preview).toContain('Assistant: approved body');
    });

    it('commits the latest rerendered revision', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        regexMocks.applyRegexToMessage.mockResolvedValue('A <b>B</b>');
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = {
            show: vi.fn(async ({ rerender }) => {
                const next = await rerender({ stripTags: true });
                expect(next.preview).toContain('Assistant: A B');
                return { approved: true, revision: next.revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome.status).toBe('committed');
        expect(getChatStore().preservedMessages[0].text).toBe('Assistant: A B');
    });

    it('returns stale when source bytes change during confirmation', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'before' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = {
            show: vi.fn(async ({ revision }) => {
                chat[0].mes = 'edited';
                return { approved: true, revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'stale' });
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('returns stale when render output changes before commit', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        let calls = 0;
        regexMocks.applyRegexToMessage.mockImplementation(async () => {
            calls += 1;
            return calls === 1 ? 'first' : 'changed preset output';
        });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'stale' });
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('keeps the approved body after edits and preset changes', async () => {
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
        const approval = createPreservedMessageApproval(makeDeps());
        const outcome = await approval.approve({ messageId: 'm1', confirm: approvedConfirm() });

        expect(outcome.status).toBe('committed');
        chat[1].mes = 'edited body';
        regexMocks.applyRegexToMessage.mockResolvedValue('changed preset output');

        expect(getChatStore().preservedMessages).toEqual([
            expect.objectContaining({ id: 'm1', text: 'Assistant: approved body' }),
        ]);
        expect(getChatStore().mutationEpoch).toBe(1);
    });

    it('skips without confirmation when disabled', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { uiMode: 'off' },
        });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'disabled' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('skips without confirmation when busy', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(
            makeDeps({ queue: { isBusy: () => true } }),
        );
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'busy' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('skips without confirmation when frozen', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(
            makeDeps({ gate: { isFrozen: () => true } }),
        );
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'frozen' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('skips without confirmation when generating', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps({ isGenerating: () => true }));
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'generating' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('skips when the freeze starts before commit', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        let frozen = false;
        const approval = createPreservedMessageApproval(
            makeDeps({ gate: { isFrozen: () => frozen } }),
        );
        const confirm = {
            show: vi.fn(async ({ revision }) => {
                frozen = true;
                return { approved: true, revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'frozen' });
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('commits despite unrelated settings and epoch drift', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore();
        const ctx = installSummaryContext({ chat, metadata: { summaryception: store } });
        regexMocks.applyRegexToMessage.mockResolvedValue('stable');
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = {
            show: vi.fn(async ({ revision }) => {
                ctx.extensionSettings.summaryception.maxSummaryTurns = 99;
                getChatStore().mutationEpoch = 5;
                return { approved: true, revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome.status).toBe('committed');
        expect(getChatStore().preservedMessages).toHaveLength(1);
        expect(getChatStore().preservedMessages[0].text).toBe('Assistant: stable');
        expect(getChatStore().mutationEpoch).toBe(6);
    });

    it('keeps independent candidates for concurrent approvals', async () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'first' }),
            makeMessage({ scId: 'm1', mes: 'second' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        regexMocks.applyRegexToMessage.mockImplementation(async (mes) => `rendered-${mes}`);
        const approval = createPreservedMessageApproval(makeDeps());

        const first = approval.approve({
            messageId: 'm0',
            confirm: { show: async ({ revision }) => ({ approved: true, revision }) },
        });
        const second = approval.approve({
            messageId: 'm1',
            confirm: { show: async ({ revision }) => ({ approved: true, revision }) },
        });
        const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

        expect(firstOutcome.status).toBe('committed');
        expect(secondOutcome.status).toBe('committed');
        expect(
            getChatStore()
                .preservedMessages.map((record) => record.id)
                .sort(),
        ).toEqual(['m0', 'm1']);
        expect(getChatStore().preservedMessages.find((record) => record.id === 'm0')?.text).toBe(
            'Assistant: rendered-first',
        );
        expect(getChatStore().preservedMessages.find((record) => record.id === 'm1')?.text).toBe(
            'Assistant: rendered-second',
        );
    });

    it('skips without a write on dismissal', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = { show: vi.fn(async () => ({ approved: false })) };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'cancelled' });
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('skips without a write when confirmation is unavailable', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps());

        const outcome = await approval.approve({ messageId: 'm0' });

        expect(outcome).toEqual({ status: 'skipped', reason: 'unavailable' });
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('returns eligibility data without invoking confirmation', async () => {
        const hidden = makeMessage({ scId: 'hidden', isHidden: true });
        const chat = [hidden];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'hidden', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'hidden' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('skips empty output without invoking confirmation', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        regexMocks.applyRegexToMessage.mockResolvedValue('   ');
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = approvedConfirm();

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'skipped', reason: 'empty' });
        expect(confirm.show).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('rejects a superseded revision as stale', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        regexMocks.applyRegexToMessage.mockResolvedValue('body');
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = {
            show: vi.fn(async ({ revision, rerender }) => {
                await rerender({ stripTags: true });
                return { approved: true, revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'stale' });
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('rejects a pending rerender as stale', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw' })];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        const approval = createPreservedMessageApproval(makeDeps());
        const confirm = {
            show: vi.fn(async ({ revision, rerender }) => {
                void rerender({ stripTags: true });
                return { approved: true, revision };
            }),
        };

        const outcome = await approval.approve({ messageId: 'm0', confirm });

        expect(outcome).toEqual({ status: 'stale' });
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('restores records and epoch and throws when persistence fails', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore();
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const failure = new Error('save failed');
        const approval = createPreservedMessageApproval(
            makeDeps({
                saveChatStore: vi.fn().mockRejectedValueOnce(failure),
            }),
        );

        await expect(
            approval.approve({ messageId: 'm0', confirm: approvedConfirm() }),
        ).rejects.toBe(failure);
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });
});
