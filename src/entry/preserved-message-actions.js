import { getChat, getEventSource, getEventTypes, getPopupApi } from '../foundation/context.js';
import { TOAST_TITLE } from '../foundation/constants.js';
import { getChatStore } from '../foundation/chat-store.js';
import { ensureChatScIds, getMessageIndexByScId } from '../foundation/message-identity.js';
import { refreshFull } from '../foundation/refresh.js';
import { warn } from '../foundation/logger.js';
import {
    getPreservationEligibility,
    reconcilePreservedMessages,
    getPreservedMessages,
} from '../core/preserved-messages.js';
import { persistChatState } from '../core/persist-state.js';

const PRESERVE_ACTION_SELECTOR = '.sc-preserve-verbatim';
const DEFAULT_PRESERVE_RENDER_OPTIONS = Object.freeze({
    regexAtAnyDepth: true,
    stripCn: true,
    stripTags: false,
});

/** @type {{ approve: (request: { messageId: string, confirm: { show: (input: object) => Promise<unknown> }, options?: object }) => Promise<{ status: string, reason?: string }> } | null} */
let actionApproval = null;
/** @type {Document | null} */
let boundDocument = null;
/** @type {MutationObserver | null} */
let chatObserver = null;
/** @type {Promise<void> | null} */
let reconciliationPromise = null;
let reconciliationQueued = false;

/**
 * @param {{ gate?: import('../core/foreground-gate.js').ForegroundGate, queue?: import('../core/summarizer-queue.js').SummarizerQueue, preservedApproval?: { approve: (request: object) => Promise<object> } }} deps
 * @returns {void}
 */
export function bindPreservedMessageActions(deps) {
    actionApproval = deps?.preservedApproval ?? null;
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
    const approval = actionApproval;
    if (!approval || typeof approval.approve !== 'function') {
        return;
    }
    const messageId = resolvePreservedMessageId(this);
    if (!messageId) {
        return;
    }
    const chat = getChat();
    const store = getChatStore();
    const index = getMessageIndexByScId(chat).get(messageId);
    const message = index !== undefined ? chat[index] : undefined;
    const eligibility = getPreservationEligibility(message, chat, store);
    if (!eligibility.eligible) {
        showEligibilityGuidance(eligibility.reason);
        return;
    }
    const confirm = createPreserveConfirm();
    let outcome;
    try {
        outcome = await approval.approve({ messageId, confirm });
    } catch (error) {
        warn('Preserve verbatim failed:', error);
        warnPreservation('Preserve verbatim failed. Nothing was saved.');
        return;
    }
    handlePreservationOutcome(outcome);
}

/**
 * Map one approval outcome to its entry effect: refresh on commit, a change
 * notice on stale, existing guidance for eligibility reasons, silence else.
 * @param {{ status: string, reason?: string } | null} outcome
 * @returns {void}
 */
function handlePreservationOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') {
        return;
    }
    if (outcome.status === 'committed') {
        refreshFull();
        syncPreservedMessageActions();
        return;
    }
    if (outcome.status === 'stale') {
        warnPreservation('The message changed while the dialog was open. Nothing was preserved.');
        return;
    }
    if (
        outcome.status === 'skipped' &&
        (outcome.reason === 'summarized' ||
            outcome.reason === 'hidden' ||
            outcome.reason === 'system' ||
            outcome.reason === 'preserved')
    ) {
        showEligibilityGuidance(outcome.reason);
    }
}

/**
 * @param {Element} button
 * @returns {string | null} Stable message id for the clicked action, or null.
 */
function resolvePreservedMessageId(button) {
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
    return id;
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
/**
 * Build the Popup adapter for the core revision contract. The adapter
 * serializes cleanup changes, awaits the latest rerender, displays its
 * preview, and returns the displayed revision on approval.
 * @returns {{ show: (input: { preview: string, revision: number, rerender: (options: object) => Promise<{ revision: number, preview: string }> }) => Promise<number | null> }}
 */
function createPreserveConfirm() {
    return { show: showPreserveDialog };
}

/**
 * Show the cleanup dialog for one approval. Each change awaits its rerender
 * and displays the latest revision; approval names that revision.
 * @param {{ preview: string, revision: number, rerender: (options: object) => Promise<{ revision: number, preview: string }> }} input
 * @returns {Promise<number | null>} Displayed revision on approval, else null.
 */
async function showPreserveDialog({ preview, revision, rerender }) {
    const popupApi = getPopupApi();
    if (!popupApi) {
        return null;
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

    let displayedRevision = revision;
    let disposed = false;
    $options.on('change', () => {
        const options = readPreserveOptions($content);
        void Promise.resolve()
            .then(() => rerender(options))
            .then((next) => {
                if (!next || typeof next.revision !== 'number') {
                    return;
                }
                if (!disposed && next.revision > displayedRevision) {
                    displayedRevision = next.revision;
                    $preview.text(
                        next.preview || 'The selected cleanup options produce an empty message.',
                    );
                }
            })
            .catch((error) => {
                if (!disposed) {
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
    disposed = true;
    if (result === popupApi.popupResult.AFFIRMATIVE) {
        return displayedRevision;
    }
    return null;
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
