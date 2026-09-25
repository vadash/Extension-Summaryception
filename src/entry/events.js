import { getChat, getGroupId, getName1, isDryRunEvent } from '../foundation/context.js';
import { isTraceEnabled, trace, warn } from '../foundation/logger.js';
import { ensureChatScIds } from '../foundation/message-identity.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { refreshFull, refreshPreview, refreshUi } from '../foundation/refresh.js';
import { syncGhosting } from '../core/ghosting.js';
import { isAuditorTriggerMessage } from '../core/continuity-audit.js';
import { discardCheckpoint } from '../core/continuity-checkpoint.js';
import {
    beginRerollTail,
    endRerollTail,
    isRerollTailInFlight,
} from '../core/continuity-coverage.js';
import { maskUserRoleAsAssistantInGenerateData } from '../core/assistant-role-mask.js';
import { evaluateStaleCacheAdvice, isProviderCacheMode } from '../core/cache-staleness.js';
import { buildChatWindowPlan } from '../core/chat-window-planner.js';
import { updateContinuityInjection } from '../features/continuity-injection.js';
import { updateContinuityMarker } from './continuity-marker.js';
import { flushPendingChatSave, persistChatState } from '../core/persist-state.js';
import { pauseMemoryToastForGeneration, showStaleCacheAdvice } from './ui-dialogs.js';

let previousPromptSectionHashes = [];

/**
 * Log one prefix-stability verdict for each final, non-dry-run chat prompt.
 * Both dry-run forms (payload flag, separate argument) are ignored before any comparison state updates.
 * @param {...unknown} args - CHAT_COMPLETION_PROMPT_READY event arguments.
 * @returns {void}
 */
export function onChatCompletionPromptReady(...args) {
    const [eventData, dryRun] = args;
    if (isDryRunEvent(eventData, dryRun) || !eventData || typeof eventData !== 'object') {
        return;
    }
    const chat = /** @type {{ chat?: unknown }} */ (eventData).chat;
    if (!Array.isArray(chat)) {
        return;
    }

    const nextHashes = chat.map((section) => hashPromptSection(section));
    const stablePrefixLength = countStablePrefix(previousPromptSectionHashes, nextHashes);
    const previousLength = previousPromptSectionHashes.length;
    const prefixBroken = previousLength > 0 && stablePrefixLength < previousLength;

    if (previousLength === 0) {
        trace(`Prompt prefix baseline: ${nextHashes.length} blocks`);
    } else if (prefixBroken) {
        if (isTraceEnabled()) {
            logBrokenPromptPrefix({
                stablePrefixLength,
                previousLength,
                currentLength: nextHashes.length,
                block: chat[stablePrefixLength],
            });
        }
    } else {
        const addedRoles = chat
            .slice(previousLength)
            .map((section) => String(section?.role || 'unknown'))
            .join(', ');
        const added = nextHashes.length - previousLength;
        trace(
            `Prompt prefix OK: ${stablePrefixLength} stable blocks, ${added} added${addedRoles ? ` (${addedRoles})` : ''}`,
        );
    }

    previousPromptSectionHashes = nextHashes;
}

function logBrokenPromptPrefix({ stablePrefixLength, previousLength, currentLength, block }) {
    const title = `Prompt prefix BROKEN at block ${stablePrefixLength}: previous ${previousLength}, current ${currentLength}`;
    console.groupCollapsed(`[Summaryception] [TRACE] ${title}`);
    try {
        console.log(
            JSON.stringify(
                {
                    type: 'summaryception.prompt.prefix-broken.v1',
                    block: stablePrefixLength,
                    previousLength,
                    currentLength,
                    newBlock: block ?? null,
                },
                null,
                2,
            ),
        );
    } finally {
        console.groupEnd();
    }
}

function countStablePrefix(previousHashes, nextHashes) {
    const limit = Math.min(previousHashes.length, nextHashes.length);
    let index = 0;
    while (index < limit && previousHashes[index] === nextHashes[index]) {
        index++;
    }
    return index;
}

function hashPromptSection(section) {
    const text = stableSerialize(section);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableSerialize(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
        .join(',')}}`;
}

// ─── Event Handlers ──────────────────────────────────────────────────

let reconcileTimer = null;
let reconcilePromise = null;
let reconcileQueued = false;
let promptFreezeRecoveryBound = false;

/**
 * Debounces the automatic cycle so fast message streams queue one request.
 * A fresh or regenerated assistant reply also kicks off one Continuity
 * Audit; the audit owns every further gate.
 * @param {number} messageIndex
 * @param {object} options
 * @param {import('../core/notify.js').NotifyAdapter} [options.notify] - Notify adapter for auditor notices
 * @param {unknown} [options.type] - MESSAGE_RECEIVED type argument; 'normal' triggers an audit, the other types dispatch nothing
 * @param {{ audit: (input: import('../core/continuity-audit.js').ContinuityAuditInput) => Promise<unknown> }} options.auditor - Continuity Audit built at the composition root
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} options.queue - Summarizer Queue a new reply kicks
 * @returns {void}
 */
export function onMessageReceived(messageIndex, { notify, type, auditor, queue }) {
    try {
        const chat = getChat();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            trace('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await queue.request();
                refreshUi();
            }, 500);
            if (isAuditorTriggerMessage(msg, type)) {
                void auditor.audit(gatherAuditInputs(notify)).catch((e) => {
                    warn('Continuity auditor run error:', e);
                });
            }
        }
    } catch (e) {
        warn('onMessageReceived error:', e);
    }
}

/**
 * Read the host facts one Continuity Audit needs. Entry owns the host reads;
 * the audit owns every gate past this point.
 * @param {import('../core/notify.js').NotifyAdapter} [notify] - Notify adapter threaded to the dispatch call.
 * @returns {import('../core/continuity-audit.js').ContinuityAuditInput}
 */
function gatherAuditInputs(notify) {
    return {
        chat: getChat(),
        store: getChatStore(),
        settings: getEffectiveSettings(),
        hasGroup: Boolean(getGroupId()),
        playerName: getName1(),
        rerollTail: isRerollTailInFlight(),
        notify,
    };
}

/**
 * Reconciles the loaded chat before any automatic cycle can read it.
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {void}
 */
export function onChatChanged({ gate, queue }) {
    trace('Chat changed.');
    recoverPromptFreeze('chat change', gate);
    scheduleLoadedChatReconciliation(gate, queue);
}

/**
 * Reconcile persisted Summaryception state after app load.
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {Promise<void>}
 */
export async function onAppReady({ gate, queue }) {
    gate.reset();
    await runSerializedReconciliation(gate, queue);
}

/**
 * Bind browser lifecycle cleanup for prompt mutation freezes.
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate }} deps
 * @returns {void}
 */
export function bindPromptFreezeRecoveryEvents({ gate }) {
    const win = globalThis.window;
    if (promptFreezeRecoveryBound || !win || typeof win.addEventListener !== 'function') {
        return;
    }

    win.addEventListener('beforeunload', () => recoverPromptFreeze('page unload', gate));
    win.addEventListener('focus', () => recoverPromptFreeze('window focus', gate));

    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', () => onVisibilityChange(gate));
    }

    promptFreezeRecoveryBound = true;
}

/**
 * Freezes prompt mutations for host generations; dry runs and own requests are excluded.
 * @param {unknown[]} args - GENERATION_STARTED event arguments.
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {void}
 */
export function onGenerationStarted(args, { gate, queue }) {
    if (isDryRunEvent(args[1], args[2])) {
        trace('Ignoring generation start from SillyTavern dry run.');
        return;
    }
    if (queue.isRequestLive()) {
        trace('Ignoring generation start from active Summaryception request.');
        return;
    }
    // A reroll replaces the last reply; its own checkpoint must leave the
    // read model and the prompt view must exclude that reply before the freeze
    // locks the slot content in. The hook is the gate's pre-freeze window, so
    // both land even when a stale-heal is still in flight.
    gate.beginGeneration({
        beforeFreeze: () => {
            const chat = getChat();
            beginRerollTail(args[0], chat);
            if (discardCheckpoint(chat, args[0])) {
                updateContinuityInjection();
                updateContinuityMarker();
            }
        },
    });
    pauseMemoryToastForGeneration();
    refreshUi();
}

/**
 * Unfreezes prompt mutations after a host generation ends.
 * @param {{ gate: import('../core/foreground-gate.js').ForegroundGate, queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {void}
 */
export function onGenerationEnded({ gate, queue }) {
    const hasActiveSummaryRequest = queue.isRequestLive();
    const hasFrozenMutations = gate.isFrozen();

    if (hasActiveSummaryRequest && !hasFrozenMutations) {
        trace('Ignoring generation end from active Summaryception request.');
        return;
    }

    endRerollTail();
    void (async () => {
        try {
            await gate.endGeneration();
            await flushPendingChatSave();
            await queue.request();
        } finally {
            refreshUi();
        }
    })()
        .catch((error) => {
            warn('Error while ending foreground generation:', error);
        })
        .finally(() => {
            refreshFull();
        });
}

/**
 * Rewrite final foreground prompt roles after ST assembles generation data.
 * @param {unknown} dryRun - Whether this is a prompt-inspection dry run.
 * @returns {void}
 */
export function onGenerateAfterData(generateData, dryRun) {
    if (isDryRunEvent(generateData, dryRun)) {
        return;
    }
    try {
        maskUserRoleAsAssistantInGenerateData(generateData, getEffectiveSettings());
    } catch (e) {
        warn('onGenerateAfterData error:', e);
    }
}

/**
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 * @returns {void}
 */
function onVisibilityChange(gate) {
    const doc = globalThis.document;
    if (!doc || doc.visibilityState === 'visible' || doc.hidden === false) {
        recoverPromptFreeze('tab visible', gate);
    }
}

/**
 * @param {string} reason
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 * @returns {void}
 */
function recoverPromptFreeze(reason, gate) {
    void gate.heal(reason, { refreshUi }).catch((error) => {
        warn('Error while recovering foreground generation freeze:', error);
    });
}

/**
 * Normalize message IDs, refresh injection, then restore missing ghost flags.
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 */
async function reconcileLoadedChatState(gate) {
    const chat = getChat();
    if (ensureChatScIds(chat)) {
        await persistChatState();
    }
    refreshPreview();
    await syncGhosting({ gate });
}

/**
 * Debounce loaded-chat reconciliation after chat save/load bursts.
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue
 * @returns {void}
 */
function scheduleLoadedChatReconciliation(gate, queue) {
    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
    }
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void runSerializedReconciliation(gate, queue);
    }, 100);
}

/**
 * Run loaded-chat reconciliation serially, coalescing queued requests.
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue
 * @returns {Promise<void>}
 */
async function runSerializedReconciliation(gate, queue) {
    if (reconcilePromise) {
        reconcileQueued = true;
        return await reconcilePromise;
    }

    reconcilePromise = drainReconciliationQueue(gate, queue);
    try {
        await reconcilePromise;
    } finally {
        reconcilePromise = null;
    }
}

/**
 * Drain one or more coalesced reconciliation requests.
 * @param {import('../core/foreground-gate.js').ForegroundGate} gate
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue
 * @returns {Promise<void>}
 */
async function drainReconciliationQueue(gate, queue) {
    do {
        reconcileQueued = false;
        await reconcileLoadedChatState(gate);
        refreshUi();
    } while (reconcileQueued);
    await checkStaleCacheAdvice(queue);
}

let staleCacheAdviceKey = '';

/**
 * Suggest an early Force Summarize when the loaded chat's provider cache is
 * stale. Shown once per queue state per page session.
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} queue
 * @returns {Promise<void>}
 */
async function checkStaleCacheAdvice(queue) {
    try {
        const settings = getEffectiveSettings();
        if (!settings.enabled || !isProviderCacheMode(settings) || queue.isRequestLive()) {
            return;
        }
        const chat = getChat();
        const plan = await buildChatWindowPlan(chat, getChatStore(), settings);
        const advice = evaluateStaleCacheAdvice({ chat, plan, settings });
        if (!advice.advise) {
            return;
        }
        const adviceKey = `${chat.length}:${advice.queuedTurns}:${chat.at(-1)?.sc_id ?? ''}`;
        if (adviceKey === staleCacheAdviceKey) {
            return;
        }
        staleCacheAdviceKey = adviceKey;
        showStaleCacheAdvice(advice);
    } catch (e) {
        warn('Stale-cache advice check failed:', e);
    }
}
