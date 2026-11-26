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
const DEFAULT_PRESERVE_RENDER_OPTIONS = Object.freeze({
    regexAtAnyDepth: true,
    stripCn: true,
    stripTags: false,
});

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
    let approval = await preparePreservationApproval(captured, deps);
    if (!approval) {
        return;
    }
    const confirmation = await confirmPreservation(approval.preview, async (options) => {
        const next = await preparePreservationApproval(captured, deps, options, true);
        return next?.preview ?? '';
    });
    if (!confirmation.approved) {
        return;
    }
    approval = await preparePreservationApproval(captured, deps, confirmation.options);
    if (!approval || !isApprovalCurrent(captured, deps, approval)) {
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
 * @param {import('../core/preserved-messages.js').PreservedMessageRenderOptions} [options]
 * @param {boolean} [quiet]
 * @returns {Promise<{ preview: string, snapshot: SummaryceptionPreservedMessage, settingsFingerprint: string, previewEpoch: number, previewIndex: number | undefined } | null>}
 */
async function preparePreservationApproval(
    captured,
    deps,
    options = DEFAULT_PRESERVE_RENDER_OPTIONS,
    quiet = false,
) {
    const snapshot = await buildPreservedMessageSnapshot(
        captured.message,
        captured.chat,
        getChatStore(),
        options,
    );
    if (!isCapturedMessageCurrent(captured) || !canPreserveNow(deps)) {
        return null;
    }
    const eligibility = getPreservationEligibility(captured.message, getChat(), getChatStore());
    if (!eligibility.eligible) {
        if (!quiet) {
            showEligibilityGuidance(eligibility.reason);
        }
        return null;
    }
    if (!snapshot) {
        if (!quiet) {
            warnPreservation('The selected cleanup options produced an empty message.');
        }
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
        if (!quiet) {
            warnPreservation(
                'The active Memory Injection template cannot show this preserved message.',
            );
        }
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
 * @param {(options: import('../core/preserved-messages.js').PreservedMessageRenderOptions) => Promise<string>} renderPreview
 * @returns {Promise<{ approved: boolean, options: import('../core/preserved-messages.js').PreservedMessageRenderOptions }>}
 */
async function confirmPreservation(preview, renderPreview) {
    const popupApi = getPopupApi();
    if (!popupApi) {
        warnPreservation('The host confirmation dialog is unavailable. Nothing was preserved.');
        return { approved: false, options: { ...DEFAULT_PRESERVE_RENDER_OPTIONS } };
    }
    const $content = $('<div class="sc-preserve-dialog"></div>');
    const $options = $('<fieldset class="sc-preserve-options"></fieldset>');
    $options.append(
        $('<legend class="sc-preserve-options-title"></legend>').text(
            'Cleanup for this preserved message',
        ),
    );
    $options.append(
        createPreserveOption(
            'sc-preserve-regex-depth',
            'Apply regex at any depth',
            DEFAULT_PRESERVE_RENDER_OPTIONS.regexAtAnyDepth,
        ),
    );
    $options.append(
        createPreserveOption(
            'sc-preserve-strip-cn',
            'Strip Chinese ideographs',
            DEFAULT_PRESERVE_RENDER_OPTIONS.stripCn,
        ),
    );
    $options.append(
        createPreserveOption(
            'sc-preserve-strip-tags',
            'Strip markup tags and keep only visible text',
            DEFAULT_PRESERVE_RENDER_OPTIONS.stripTags,
        ),
    );
    const $preview = $('<pre class="sc-preserve-preview"></pre>').text(preview);
    $content.append($options);
    $content.append($preview);

    let renderVersion = 0;
    let closed = false;
    $options.on('change', () => {
        const version = ++renderVersion;
        const options = readPreserveOptions($content);
        void Promise.resolve()
            .then(() => renderPreview(options))
            .then((nextPreview) => {
                if (!closed && version === renderVersion) {
                    $preview.text(
                        nextPreview || 'The selected cleanup options produce an empty message.',
                    );
                }
            })
            .catch((error) => {
                if (!closed && version === renderVersion) {
                    $preview.text('Preview update failed. Choose No and try again.');
                    warn('Preserve preview update failed:', error);
                }
            });
    });

    const PopupCtor =
        /** @type {new (content: unknown, type: number, inputValue?: string, options?: Record<string, unknown>) => { show: () => Promise<unknown> }} */ (
            popupApi.Popup
        );
    const popup = new PopupCtor($content, popupApi.popupType.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Yes',
        cancelButton: 'No',
    });
    const result = await popup.show();
    closed = true;
    return {
        approved: result === popupApi.popupResult.AFFIRMATIVE,
        options: readPreserveOptions($content),
    };
}

/**
 * @param {string} className
 * @param {string} label
 * @param {boolean} checked
 * @returns {object}
 */
function createPreserveOption(className, label, checked) {
    return $('<label class="sc-preserve-option"></label>')
        .append($(`<input type="checkbox" class="${className}">`).prop('checked', checked))
        .append($('<span></span>').text(label));
}

/**
 * @param {object} $content
 * @returns {import('../core/preserved-messages.js').PreservedMessageRenderOptions}
 */
function readPreserveOptions($content) {
    return {
        regexAtAnyDepth: $content.find('.sc-preserve-regex-depth').prop('checked'),
        stripCn: $content.find('.sc-preserve-strip-cn').prop('checked'),
        stripTags: $content.find('.sc-preserve-strip-tags').prop('checked'),
    };
}
