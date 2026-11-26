import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as regexProxy from '../src/core/regex-proxy.js';
import { getChatStore } from '../src/foundation/chat-store.js';
import { bindUIEvents } from '../src/entry/ui-events.js';
import { syncPreservedMessageActions } from '../src/entry/preserved-message-actions.js';
import { onAppReady } from '../src/entry/events.js';
import {
    createJQueryHarness,
    deferred,
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeNotifyRecorder,
    makePreservedApproval,
    makeToastrMock,
    makeSummaryStore,
} from './test-helpers.js';

const PRESERVE_SELECTOR = '.sc-preserve-verbatim';

function installPopup(result) {
    const instances = [];
    const ctx = globalThis.SillyTavern.getContext();
    ctx.POPUP_TYPE = { TEXT: 1 };
    ctx.POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    ctx.Popup = class {
        constructor(content, type, inputValue, options) {
            this.content = content;
            this.type = type;
            this.inputValue = inputValue;
            this.options = options;
            instances.push(this);
        }
        async show() {
            return await result;
        }
    };
    return instances;
}

function setupActions({
    chat,
    store = makeSummaryStore(),
    settings = {},
    busy = false,
    beforeBind,
    ...host
} = {}) {
    installSummaryContext({ chat, metadata: { summaryception: store }, settings, ...host });
    const dom = createJQueryHarness({ messages: chat });
    globalThis.toastr = makeToastrMock();
    globalThis.$ = dom.$;
    const queue = { isBusy: () => busy, request: async () => {} };
    const gate = makeForegroundGate().gate;
    const preservedApproval = makePreservedApproval({ gate, queue });
    const deps = {
        notify: makeNotifyRecorder(),
        gate,
        queue,
        manualRunnerDeps: { queue },
        preservedApproval,
    };
    beforeBind?.(dom);
    bindUIEvents(deps);
    return { dom, queue, gate, store, deps, preservedApproval };
}

function clickPreserve(dom, index) {
    const $action = dom.renderedMessages[index].$buttons.find(PRESERVE_SELECTOR);
    return dom.trigger('click', PRESERVE_SELECTOR, $action.nodes[0]);
}

describe('Preserve verbatim message actions', () => {
    beforeEach(() => {
        globalThis.document = {};
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.document;
        delete globalThis.$;
        delete globalThis.MutationObserver;
        delete globalThis.confirm;
    });

    it('approves the exact projected memory and persists its immutable snapshot', async () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'old user', isUser: true }),
            makeMessage({ scId: 'm1', mes: 'old reply' }),
            makeMessage({ scId: 'm2', mes: 'raw target' }),
            makeMessage({ scId: 'm3', mes: 'later', isUser: true }),
        ];
        const store = makeSummaryStore({
            layers: [
                [
                    {
                        text: '<narrative>Earlier</narrative>',
                        sourceMessageIds: ['m0', 'm1'],
                        currentDateTime: '2024-07-04 16 Thu',
                    },
                ],
            ],
        });
        const { dom } = setupActions({
            chat,
            store,
            settings: { injectionTemplate: 'BEGIN\n{{summary}}\nMID\n{{summary}}\nEND' },
        });
        const popups = installPopup(1);
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue(
            'Keep\u2800<preserved>exact</preserved>',
        );

        await clickPreserve(dom, 2);

        expect(popups).toHaveLength(1);
        const $preview = globalThis.$(popups[0].content.find('.sc-preserve-preview').nodes[0]);
        expect($preview.text()).toBe(
            'BEGIN\n' +
                '[0-1@2024-07-04T16] Earlier\n' +
                '[2-2@2024-07-04T16] <preserved>Assistant: Keep &lt;preserved&gt;exact&lt;/preserved&gt;</preserved>\n' +
                'MID\n' +
                '[0-1@2024-07-04T16] Earlier\n' +
                'END',
        );
        expect(getChatStore().preservedMessages).toEqual([
            {
                id: 'm2',
                text: 'Assistant: Keep &lt;preserved&gt;exact&lt;/preserved&gt;',
                currentDateTime: '2024-07-04 16 Thu',
                handedOff: false,
            },
        ]);
        expect(Object.isFrozen(getChatStore().preservedMessages[0])).toBe(true);
        expect(getChatStore().mutationEpoch).toBe(1);
        expect(chat[2].mes).toBe('raw target');
        expect(chat[2].is_hidden).toBe(false);
        const $action = dom.renderedMessages[2].$buttons.find(PRESERVE_SELECTOR);
        expect($action.prop('disabled')).toBe(true);
    });

    it('applies modal cleanup choices to the live preview and stored snapshot', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'raw target' })];
        const { dom } = setupActions({ chat });
        const dialog = deferred();
        const popups = installPopup(dialog.promise);
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue(
            'A 漢 <marigold:whisper>B</marigold:whisper>',
        );

        const clicking = clickPreserve(dom, 0);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        const content = popups[0].content;
        expect(content.find('.sc-preserve-regex-depth').prop('checked')).toBe(true);
        expect(content.find('.sc-preserve-strip-cn').prop('checked')).toBe(true);
        expect(content.find('.sc-preserve-strip-tags').prop('checked')).toBe(false);
        const previewText = () =>
            globalThis.$(content.find('.sc-preserve-preview').nodes[0]).text();
        expect(previewText()).not.toContain('漢');
        expect(previewText()).toContain('<marigold:whisper>B</marigold:whisper>');

        content.find('.sc-preserve-strip-tags').prop('checked', true);
        dom.trigger('change', '<fieldset class="sc-preserve-options"></fieldset>');

        await vi.waitFor(() => expect(previewText()).not.toContain('<marigold:whisper>'));
        expect(previewText()).toContain('A B');
        dialog.resolve(1);
        await clicking;
        expect(getChatStore().preservedMessages[0].text).toBe('Assistant: A B');
    });

    it('approves preservation when the host returns a fresh context wrapper per call', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const popups = installPopup(1);
        const context = globalThis.SillyTavern.getContext();
        globalThis.SillyTavern.getContext = () => ({ ...context });
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue('approved');

        await clickPreserve(dom, 0);

        expect(popups).toHaveLength(1);
        expect(getChatStore().preservedMessages).toEqual([
            {
                id: 'm0',
                text: 'Assistant: approved',
                handedOff: false,
            },
        ]);
    });

    it.each([2, 0])('stores nothing when the host dialog returns %s', async (result) => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        installPopup(result);
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue('approved');

        await clickPreserve(dom, 0);

        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            false,
        );
    });

    it('does not commit when the chat changes while the dialog is open', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const dialog = deferred();
        const popups = installPopup(dialog.promise);
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue('approved');

        const clicking = clickPreserve(dom, 0);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        const ctx = globalThis.SillyTavern.getContext();
        ctx.chatId = 'other-chat';
        dialog.resolve(1);
        await clicking;

        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
        expect(globalThis.toastr.warning).toHaveBeenCalledOnce();
    });

    it('awaits a pending cleanup rerender before approval and commits its preview', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const dialog = deferred();
        const popups = installPopup(dialog.promise);
        let releaseRerender;
        const rerenderGate = new Promise((resolve) => {
            releaseRerender = resolve;
        });
        let calls = 0;
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                return 'approved';
            }
            await rerenderGate;
            return 'rerendered';
        });

        const clicking = clickPreserve(dom, 0);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        const content = popups[0].content;
        content.find('.sc-preserve-strip-tags').prop('checked', true);
        dom.trigger('change', '<fieldset class="sc-preserve-options"></fieldset>');
        await vi.waitFor(() => expect(regexProxy.applyRegexToMessage).toHaveBeenCalledTimes(2));
        dialog.resolve(1);
        releaseRerender();
        await clicking;

        expect(getChatStore().preservedMessages).toEqual([
            expect.objectContaining({ id: 'm0', text: 'Assistant: rerendered' }),
        ]);
        expect(getChatStore().mutationEpoch).toBe(1);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    it('never lets a slow earlier rerender overwrite a later one', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const dialog = deferred();
        const popups = installPopup(dialog.promise);
        let releaseSlow;
        const slowGate = new Promise((resolve) => {
            releaseSlow = resolve;
        });
        let calls = 0;
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                return 'approved';
            }
            if (calls === 2) {
                await slowGate;
                return 'SLOW RESULT';
            }
            return 'FAST RESULT';
        });

        const clicking = clickPreserve(dom, 0);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        const content = popups[0].content;
        const previewText = () =>
            globalThis.$(content.find('.sc-preserve-preview').nodes[0]).text();
        content.find('.sc-preserve-strip-tags').prop('checked', true);
        dom.trigger('change', '<fieldset class="sc-preserve-options"></fieldset>');
        await vi.waitFor(() => expect(regexProxy.applyRegexToMessage).toHaveBeenCalledTimes(2));
        content.find('.sc-preserve-strip-cn').prop('checked', false);
        dom.trigger('change', '<fieldset class="sc-preserve-options"></fieldset>');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(regexProxy.applyRegexToMessage).toHaveBeenCalledTimes(2);
        releaseSlow();
        await vi.waitFor(() => expect(previewText()).toContain('FAST RESULT'));
        expect(previewText()).not.toContain('SLOW RESULT');
        dialog.resolve(1);
        await clicking;

        expect(getChatStore().preservedMessages).toEqual([
            expect.objectContaining({ id: 'm0', text: 'Assistant: FAST RESULT' }),
        ]);
        expect(getChatStore().mutationEpoch).toBe(1);
    });

    it('surfaces a failed rerender in the dialog and commits nothing on approval', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const dialog = deferred();
        const popups = installPopup(dialog.promise);
        let calls = 0;
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                return 'approved';
            }
            throw new Error('regex boom');
        });

        const clicking = clickPreserve(dom, 0);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        const content = popups[0].content;
        const previewText = () =>
            globalThis.$(content.find('.sc-preserve-preview').nodes[0]).text();
        content.find('.sc-preserve-strip-tags').prop('checked', true);
        dom.trigger('change', '<fieldset class="sc-preserve-options"></fieldset>');
        await vi.waitFor(() =>
            expect(previewText()).toBe('Preview update failed. Choose No and try again.'),
        );
        dialog.resolve(1);
        await clicking;

        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
    });

    it('adds one action per user and assistant message without duplicate bindings', () => {
        const chat = [
            makeMessage({ scId: 'user', isUser: true }),
            makeMessage({ scId: 'assistant' }),
            makeMessage({ scId: 'system', isSystem: true }),
        ];
        installSummaryContext({ chat });
        const dom = createJQueryHarness({ messages: chat });
        globalThis.$ = dom.$;
        const queue = { isBusy: () => false, request: async () => {} };
        const gate = makeForegroundGate().gate;
        const deps = {
            notify: makeNotifyRecorder(),
            gate,
            queue,
            manualRunnerDeps: { queue },
            preservedApproval: makePreservedApproval({ gate, queue }),
        };

        bindUIEvents(deps);
        bindUIEvents(deps);

        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(1);
        expect(dom.renderedMessages[1].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(1);
        expect(dom.renderedMessages[2].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(0);
    });

    it('does not render a dead action for empty or unidentified messages', () => {
        const empty = makeMessage({ scId: 'empty', mes: '   ' });
        const unidentified = makeMessage({ scId: 'temporary', mes: 'target' });
        delete unidentified.sc_id;
        const chat = [empty, unidentified];
        const { dom } = setupActions({ chat });

        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(0);
        expect(dom.renderedMessages[1].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(0);
    });

    it('restores one action after the host rerenders a message', () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });

        const $buttons = dom.renderedMessages[0].rerender();
        syncPreservedMessageActions();

        expect($buttons.find(PRESERVE_SELECTOR)).toHaveLength(1);
    });

    it('repairs copied identities without transferring preservation and prunes deleted sources', async () => {
        const original = makeMessage({ scId: 'm0', mes: 'target' });
        const copy = makeMessage({ scId: 'm0', mes: 'target' });
        const chat = [original, copy];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: target', handedOff: false }],
        });
        const { dom, gate, queue } = setupActions({ chat, store });

        await onAppReady({ gate, queue });

        expect(copy.sc_id).not.toBe(original.sc_id);
        expect(getChatStore().preservedMessages).toHaveLength(1);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            true,
        );
        expect(dom.renderedMessages[1].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            false,
        );

        chat.shift();
        await onAppReady({ gate, queue });

        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(1);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            false,
        );
        expect(dom.renderedMessages[1].$buttons.find(PRESERVE_SELECTOR)).toHaveLength(0);
    });

    it('shows memory handoff state without a toast', () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: target', handedOff: false }],
        });
        const { dom } = setupActions({ chat, store });
        const $action = dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR);
        const chatTitle = $action.attr('title');
        expect(chatTitle).toBeTruthy();
        expect($action.prop('disabled')).toBe(true);

        store.preservedMessages = [{ id: 'm0', text: 'Assistant: target', handedOff: true }];
        syncPreservedMessageActions();

        expect($action.prop('disabled')).toBe(true);
        expect($action.attr('title')).not.toBe(chatTitle);
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
    });

    it('offers Clear guidance for summarized messages without mutating', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'old' })];
        const store = makeSummaryStore({
            layers: [[{ text: 'old', sourceMessageIds: ['m0'] }]],
        });
        const { dom } = setupActions({ chat, store });
        const regex = vi.spyOn(regexProxy, 'applyRegexToMessage');

        await clickPreserve(dom, 0);

        expect(regex).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).toHaveBeenCalledOnce();
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('requires user-hidden messages to be unhidden without mutating', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'hidden', isHidden: true })];
        const { dom } = setupActions({ chat });
        const regex = vi.spyOn(regexProxy, 'applyRegexToMessage');

        await clickPreserve(dom, 0);

        expect(regex).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).toHaveBeenCalledOnce();
        expect(chat[0].is_hidden).toBe(true);
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it.each([
        ['Off', { settings: { uiMode: 'off' }, busy: false }],
        ['busy', { settings: {}, busy: true }],
    ])('does nothing while %s', async (_label, options) => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat, ...options });
        const regex = vi.spyOn(regexProxy, 'applyRegexToMessage');
        const popups = installPopup(1);

        await clickPreserve(dom, 0);

        expect(regex).not.toHaveBeenCalled();
        expect(popups).toEqual([]);
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('warns and stores nothing when regex produces an empty snapshot', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom } = setupActions({ chat });
        const popups = installPopup(1);
        vi.spyOn(regexProxy, 'applyRegexToMessage').mockResolvedValue('   ');

        await clickPreserve(dom, 0);

        expect(popups).toEqual([]);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).not.toHaveBeenCalled();
        expect(getChatStore().preservedMessages).toEqual([]);
        expect(getChatStore().mutationEpoch).toBe(0);
    });

    it('reconciles deletion through one idempotent host event binding', async () => {
        const handlers = new Map();
        const eventSource = {
            on: vi.fn((name, handler) => handlers.set(name, handler)),
        };
        const chat = [
            makeMessage({ scId: 'm0', mes: 'preserved' }),
            makeMessage({ scId: 'm1', mes: 'remaining' }),
        ];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: preserved', handedOff: false }],
        });
        const { dom, deps } = setupActions({
            chat,
            store,
            eventSource,
            eventTypes: { MESSAGE_DELETED: 'message-deleted' },
        });
        bindUIEvents(deps);
        expect(
            eventSource.on.mock.calls.filter(([name]) => name === 'message-deleted'),
        ).toHaveLength(1);

        chat.shift();
        handlers.get('message-deleted')();

        await vi.waitFor(() => expect(getChatStore().preservedMessages).toEqual([]));
        expect(getChatStore().mutationEpoch).toBe(1);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            false,
        );
    });

    it('reconciles chat mutations when the host emits no lifecycle event', async () => {
        let notifyMutation = null;
        const chat = [makeMessage({ scId: 'm0', mes: 'preserved' })];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: preserved', handedOff: false }],
        });
        setupActions({
            chat,
            store,
            beforeBind(dom) {
                globalThis.document.querySelector = () => dom.element('#chat')[0];
                globalThis.MutationObserver = class {
                    constructor(callback) {
                        notifyMutation = callback;
                    }
                    observe() {}
                    disconnect() {}
                };
            },
        });

        chat.splice(0);
        notifyMutation();

        await vi.waitFor(() => expect(getChatStore().preservedMessages).toEqual([]));
        expect(getChatStore().mutationEpoch).toBe(1);
    });

    it('keeps preservation attached to stable identity after messages move', () => {
        const chat = [
            makeMessage({ scId: 'm0', mes: 'preserved' }),
            makeMessage({ scId: 'm1', mes: 'middle' }),
            makeMessage({ scId: 'm2', mes: 'last' }),
        ];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: preserved', handedOff: false }],
        });
        const { dom } = setupActions({ chat, store });
        const originalOrder = [...chat];

        chat.reverse();
        dom.renderedMessages.forEach(({ $message }, renderedIndex) => {
            $message.attr('mesid', String(chat.indexOf(originalOrder[renderedIndex])));
        });
        syncPreservedMessageActions();

        expect(
            dom.renderedMessages.map(({ $buttons }) => $buttons.find(PRESERVE_SELECTOR).length),
        ).toEqual([1, 1, 1]);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            true,
        );
    });

    it('does nothing while foreground generation freezes prompt mutations', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const { dom, gate } = setupActions({ chat });
        gate.beginGeneration({ chat });
        const regex = vi.spyOn(regexProxy, 'applyRegexToMessage');
        const popups = installPopup(1);

        await clickPreserve(dom, 0);

        expect(regex).not.toHaveBeenCalled();
        expect(popups).toEqual([]);
        expect(getChatStore().preservedMessages).toEqual([]);
    });

    it('returns the action to eligible state after Clear and reconciliation', async () => {
        const chat = [makeMessage({ scId: 'm0', mes: 'target' })];
        const store = makeSummaryStore({
            preservedMessages: [{ id: 'm0', text: 'Assistant: target', handedOff: false }],
        });
        const { dom, gate, queue } = setupActions({ chat, store });
        globalThis.confirm = vi.fn(() => true);

        await dom.trigger('click', '#sc_clear_memory');
        await onAppReady({ gate, queue });

        expect(getChatStore().preservedMessages).toEqual([]);
        expect(dom.renderedMessages[0].$buttons.find(PRESERVE_SELECTOR).prop('disabled')).toBe(
            false,
        );
    });
});
