import {
    getChat,
    getContext,
    getEventSource,
    getEventTypes,
    getPopupApi,
    isGeneratingFlagSet,
} from '../foundation/context.js';
import { TOAST_TITLE } from '../foundation/constants.js';
import { getChatStore } from '../foundation/chat-store.js';
import { ensureChatScIds, getMessageIndexByScId } from '../foundation/message-identity.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { refreshFull } from '../foundation/refresh.js';
import { warn } from '../foundation/logger.js';
import {
    buildPreservedMessageSnapshot,
    commitPreservedMessage,
    getPreservationEligibility,
    reconcilePreservedMessages,
    getPreservedMessages,
} from '../core/preserved-messages.js';
import { buildInjection } from '../core/memory-injection.js';
import { persistChatState } from '../core/persist-state.js';
import { getChatIdentity } from '../core/summarizer-snapshot.js';

const PRESERVE_ACTION_SELECTOR = '.sc-preserve-verbatim';

/** @type {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue } | null} */
let actionDeps = null;
/** @type {Document | null} */
let boundDocument = null;
/** @type {MutationObserver | null} */
let chatObserver = null;
/** @type {Promise<void> | null} */
let reconciliationPromise = null;
let reconciliationQueued = false;

/**
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {void}
 */
export function bindPreservedMessageActions(deps) {
    actionDeps = deps;
    if (boundDocument !== globalThis.document) {
        boundDocument = globalThis.document;
        $(document).on('click', PRESERVE_ACTION_SELECTOR, onPreserveActionClick);
        observeChat();
        bindHostLifecycleEvents();
    }
    syncPreservedMessageActions();
}

/** @returns {void} */
export function syncPreservedMessageActions() {
    if (typeof $ !== 'function') {
        return;
    }
    const chat = getChat();
    const store = getChatStore();
    const preserved = new Map(getPreservedMessages(store).map((record) => [record.id, record]));
    $('#chat .mes').each((_index, element) => {
        const $message = $(element);
        const messageIndex = Number($message.attr('mesid'));
        const message = chat[messageIndex];
        if (
            !message ||
            message.is_system ||
            message.extra?.type ||
            typeof message.is_user !== 'boolean' ||
            typeof message.sc_id !== 'string' ||
            !String(message.mes || '').trim()
        ) {
            $message.find(PRESERVE_ACTION_SELECTOR).remove();
            return;
        }
        $message
            .find('.extraMesButtons')
            .slice(0, 1)
            .each((_index, buttonElement) => {
                const $buttons = $(buttonElement);
                const $actions = $buttons.find(PRESERVE_ACTION_SELECTOR);
                $actions.slice(1).remove();
                const $action = $actions.length > 0 ? $actions.slice(0, 1) : createPreserveAction();
                if ($actions.length === 0) {
                    $buttons.append($action);
                }
                const record =
                    typeof message.sc_id === 'string' ? preserved.get(message.sc_id) : undefined;
                const tooltip = record
                    ? record.handedOff
                        ? 'Preserved — in memory'
                        : 'Preserved — still in chat'
                    : 'Preserve verbatim';
                $action
                    .prop('disabled', Boolean(record))
                    .attr('title', tooltip)
                    .attr('aria-label', tooltip)
                    .find('i')
                    .toggleClass('fa-thumbtack', !record)
                    .toggleClass('fa-check', Boolean(record));
            });
    });
}
/**
 * Repair stable identities and prune deleted preservation sources after host
 * operations that may not emit CHAT_CHANGED.
 * @returns {Promise<void>}
 */
export function reconcilePreservedMessageActions() {
    if (reconciliationPromise) {
        reconciliationQueued = true;
        return reconciliationPromise;
    }
    reconciliationPromise = drainPreservedMessageReconciliation().finally(() => {
        reconciliationPromise = null;
    });
    return reconciliationPromise;
}

/** @returns {Promise<void>} */
async function drainPreservedMessageReconciliation() {
    do {
        reconciliationQueued = false;
        const chat = getChat();
        const identitiesChanged = ensureChatScIds(chat);
        const store = getChatStore();
        const preservedChanged = reconcilePreservedMessages(chat, store);
        if (identitiesChanged || preservedChanged) {
            syncPreservedMessageActions();
            await persistChatState({ chatSave: 'deferred' });
            refreshFull();
        }
        syncPreservedMessageActions();
    } while (reconciliationQueued);
}

/** @returns {void} */
function bindHostLifecycleEvents() {
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
        return;
    }
    const eventNames = new Set(
        [
            'MESSAGE_RENDERED',
            'MESSAGE_UPDATED',
            'MESSAGE_SWIPED',
            'MESSAGE_DELETED',
            'MORE_MESSAGES_LOADED',
            'MESSAGE_MOVED',
            'MESSAGE_COPIED',
            'USER_RENDERED',
            'ASSISTANT_RENDERED',
        ]
            .map((key) => eventTypes[key])
            .filter((name) => typeof name === 'string' && name),
    );
    for (const eventName of eventNames) {
        eventSource.on(eventName, () => {
            void reconcilePreservedMessageActions().catch((error) => {
                warn('Preserved Message lifecycle reconciliation failed:', error);
            });
        });
    }
}

/** @returns {object} */
function createPreserveAction() {
    return $('<button type="button" class="menu_button sc-preserve-verbatim"></button>')
        .html('<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>')
        .attr('title', 'Preserve verbatim')
        .attr('aria-label', 'Preserve verbatim');
}

/** @returns {void} */
function observeChat() {
    const chat =
        typeof document.querySelector === 'function' ? document.querySelector('#chat') : null;
    if (!chat || typeof MutationObserver !== 'function') {
        return;
    }
    chatObserver = new MutationObserver(() => {
        void reconcilePreservedMessageActions().catch((error) => {
            warn('Preserved Message chat reconciliation failed:', error);
        });
    });
    chatObserver.observe(chat, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['mesid'],
    });
}

/**
 * @param {Event} event
 * @returns {Promise<void>}
 */
async function onPreserveActionClick(event) {
    event.preventDefault?.();
    const deps = actionDeps;
    if (!deps || !canPreserveNow(deps)) {
        return;
    }
    const captured = capturePreservationTarget(this);
    if (!captured) {
        return;
    }
    const eligibility = getPreservationEligibility(captured.message, captured.chat, getChatStore());
    if (!eligibility.eligible) {
        showEligibilityGuidance(eligibility.reason);
        return;
    }
    const approval = await preparePreservationApproval(captured, deps);
    if (!approval || !(await confirmPreservation(approval.preview))) {
        return;
    }
    if (!isApprovalCurrent(captured, deps, approval)) {
        return;
    }
    await commitPreservationApproval(captured, approval);
}

/**
 * @param {Element} button
 * @returns {{ context: SillyTavernContext, chat: ChatMessage[], chatId: string, message: ChatMessage, messageIndex: number, id: string } | null}
 */
function capturePreservationTarget(button) {
    const context = getContext();
    const chat = getChat();
    const $message = $(button).closest('.mes');
    const messageIndex = Number($message.attr('mesid'));
    const message = chat[messageIndex];
    const id = message?.sc_id;
    if (
        !message ||
        typeof id !== 'string' ||
        getMessageIndexByScId(chat).get(id) !== messageIndex
    ) {
        return null;
    }
    return { context, chat, chatId: getChatIdentity(context), message, messageIndex, id };
}

/**
 * @param {{ context: SillyTavernContext, chat: ChatMessage[], chatId: string, message: ChatMessage, messageIndex: number, id: string }} captured
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {Promise<{ preview: string, snapshot: SummaryceptionPreservedMessage, settingsFingerprint: string, previewEpoch: number, previewIndex: number | undefined } | null>}
 */
async function preparePreservationApproval(captured, deps) {
    const snapshot = await buildPreservedMessageSnapshot(
        captured.message,
        captured.chat,
        getChatStore(),
        getEffectiveSettings(),
    );
    if (!isCapturedMessageCurrent(captured) || !canPreserveNow(deps)) {
        return null;
    }
    const eligibility = getPreservationEligibility(captured.message, getChat(), getChatStore());
    if (!eligibility.eligible) {
        showEligibilityGuidance(eligibility.reason);
        return null;
    }
    if (!snapshot) {
        warnPreservation('The active regex produced an empty message. Nothing was preserved.');
        return null;
    }
    const currentChat = getChat();
    const currentStore = getChatStore();
    const settings = getEffectiveSettings();
    const preview = buildInjection(currentStore.layers, settings, null, {
        chat: currentChat,
        preservedMessages: [...currentStore.preservedMessages, { ...snapshot, handedOff: true }],
    }).text;
    if (!preview.trim() || !preview.includes('<preserved>')) {
        warnPreservation(
            'The active Memory Injection template cannot show this preserved message.',
        );
        return null;
    }
    return {
        preview,
        snapshot,
        settingsFingerprint: JSON.stringify(settings),
        previewEpoch: currentStore.mutationEpoch,
        previewIndex: getMessageIndexByScId(currentChat).get(snapshot.id),
    };
}

/**
 * @param {{ context: SillyTavernContext, chat: ChatMessage[], chatId: string, message: ChatMessage, messageIndex: number, id: string }} captured
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @param {{ settingsFingerprint: string, previewEpoch: number, previewIndex: number | undefined }} approval
 * @returns {boolean}
 */
function isApprovalCurrent(captured, deps, approval) {
    return (
        isCapturedMessageCurrent(captured) &&
        canPreserveNow(deps) &&
        getChatStore().mutationEpoch === approval.previewEpoch &&
        getMessageIndexByScId(getChat()).get(captured.id) === approval.previewIndex &&
        JSON.stringify(getEffectiveSettings()) === approval.settingsFingerprint
    );
}

/**
 * @param {{ message: ChatMessage, id: string }} captured
 * @param {{ snapshot: SummaryceptionPreservedMessage }} approval
 * @returns {Promise<void>}
 */
async function commitPreservationApproval(captured, approval) {
    const eligibility = getPreservationEligibility(captured.message, getChat(), getChatStore());
    if (!eligibility.eligible) {
        showEligibilityGuidance(eligibility.reason);
        return;
    }
    try {
        const result = await commitPreservedMessage(approval.snapshot);
        if (result.status === 'preserved') {
            refreshFull();
        }
        syncPreservedMessageActions();
    } catch (error) {
        warn('Preserve verbatim failed:', error);
        warnPreservation('Preserve verbatim failed. Nothing was saved.');
    }
}

/**
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {boolean}
 */
function canPreserveNow(deps) {
    return (
        getEffectiveSettings().enabled &&
        !deps.queue.isBusy() &&
        !deps.gate.isFrozen() &&
        !isGeneratingFlagSet()
    );
}

/**
 * @param {{ context: SillyTavernContext, chat: ChatMessage[], chatId: string, message: ChatMessage, messageIndex: number, id: string }} captured
 * @returns {boolean}
 */
function isCapturedMessageCurrent(captured) {
    const context = getContext();
    const chat = getChat();
    const index = getMessageIndexByScId(chat).get(captured.id);
    return (
        context === captured.context &&
        chat === captured.chat &&
        getChatIdentity(context) === captured.chatId &&
        index === captured.messageIndex &&
        chat[index] === captured.message
    );
}

/** @param {string} reason */
function showEligibilityGuidance(reason) {
    if (reason === 'summarized') {
        toastr.info(
            'This message is already summarized. Clear memory, preserve the message, then Force Summarize to include it verbatim.',
            TOAST_TITLE,
        );
    } else if (reason === 'hidden') {
        toastr.info('Unhide this message before preserving it verbatim.', TOAST_TITLE);
    } else {
        warnPreservation('This message cannot be preserved verbatim. Nothing was saved.');
    }
}

/** @param {string} message */
function warnPreservation(message) {
    toastr.warning(message, TOAST_TITLE, { timeOut: 8000 });
}

/**
 * @param {string} preview
 * @returns {Promise<boolean>}
 */
async function confirmPreservation(preview) {
    const popupApi = getPopupApi();
    if (!popupApi) {
        warnPreservation('The host confirmation dialog is unavailable. Nothing was preserved.');
        return false;
    }
    const PopupCtor =
        /** @type {new (content: unknown, type: number, inputValue?: string, options?: Record<string, unknown>) => { show: () => Promise<unknown> }} */ (
            popupApi.Popup
        );
    const popup = new PopupCtor(
        $('<pre class="sc-preserve-preview"></pre>').text(preview),
        popupApi.popupType.TEXT,
        '',
        {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: 'Yes',
            cancelButton: 'No',
        },
    );
    return (await popup.show()) === popupApi.popupResult.YES;
}
