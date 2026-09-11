import { getChat, isDryRunEvent } from '../foundation/context.js';
import { debug, info, isDebugEnabled, warn } from '../foundation/logger.js';
import { ensureChatScIds } from '../foundation/message-identity.js';
import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { repairMissingGhostingForSummaries } from '../core/ghosting-reconcile.js';
import { maskUserRoleAsAssistantInGenerateData } from '../core/assistant-role-mask.js';
import { evaluateStaleCacheAdvice, isProviderCacheMode } from '../core/cache-staleness.js';
import { buildChatWindowPlan } from '../core/chat-window-planner.js';
import {
    beginForegroundGeneration,
    endForegroundGeneration,
    hasActiveAbortController,
    hasFrozenPromptMutations,
    recoverStalePromptFreeze,
    requestSummarization,
    resetPromptMutationGuard,
} from '../core/summarizer.js';
import { updateInjection } from '../features/injection.js';
import { repairOrphanedMessages } from '../features/maintenance.js';
import { persistChatState } from '../core/persist-state.js';
import { showStaleCacheAdvice } from './ui-dialogs.js';
import { updateUI } from './ui.js';

let previousPromptSectionHashes = [];

/**
 * Log one prefix-stability verdict for each final, non-dry-run chat prompt.
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
        debug(`Prompt prefix baseline: ${nextHashes.length} blocks`);
    } else if (prefixBroken) {
        if (isDebugEnabled()) {
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
        debug(
            `Prompt prefix OK: ${stablePrefixLength} stable blocks, ${added} added${addedRoles ? ` (${addedRoles})` : ''}`,
        );
    }

    previousPromptSectionHashes = nextHashes;
}

function logBrokenPromptPrefix({ stablePrefixLength, previousLength, currentLength, block }) {
    const title = `Prompt prefix BROKEN at block ${stablePrefixLength}: previous ${previousLength}, current ${currentLength}`;
    console.groupCollapsed(`[Summaryception] [DEBUG] ${title}`);
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
 *
 */
export function onMessageReceived(messageIndex) {
    try {
        const chat = getChat();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            debug('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await requestSummarization();
                updateUI();
            }, 500);
        }
    } catch (e) {
        warn('onMessageReceived error:', e);
    }
}

/**
 *
 */
export function onChatChanged() {
    debug('Chat changed.');
    recoverPromptFreeze('chat change');
    scheduleLoadedChatReconciliation();
}

/**
 * Reconcile persisted Summaryception state after app load.
 * @returns {Promise<void>}
 */
export async function onAppReady() {
    resetPromptMutationGuard();
    await runSerializedReconciliation();
}

/**
 * Bind browser lifecycle cleanup for prompt mutation freezes.
 * @returns {void}
 */
export function bindPromptFreezeRecoveryEvents() {
    const win = globalThis.window;
    if (promptFreezeRecoveryBound || !win || typeof win.addEventListener !== 'function') {
        return;
    }

    win.addEventListener('beforeunload', onBeforeUnload);
    win.addEventListener('focus', onWindowFocus);

    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    promptFreezeRecoveryBound = true;
}

/**
 *
 */
export function onGenerationStarted(...args) {
    if (isDryRunEvent(args[1], args[2])) {
        debug('Ignoring generation start from SillyTavern dry run.');
        return;
    }
    if (hasActiveAbortController()) {
        debug('Ignoring generation start from active Summaryception request.');
        return;
    }
    info('Foreground generation start detected; freezing Summaryception prompt mutations.');
    beginForegroundGeneration();
}

/**
 *
 */
export function onGenerationEnded() {
    const hasActiveSummaryRequest = hasActiveAbortController();
    const hasFrozenMutations = hasFrozenPromptMutations();

    if (hasActiveSummaryRequest && !hasFrozenMutations) {
        debug('Ignoring generation end from active Summaryception request.');
        return;
    }

    info(
        'Generation end detected; flushing Summaryception prompt mutations.',
        `activeSummaryRequest=${hasActiveSummaryRequest}`,
        `frozen=${hasFrozenMutations}`,
    );
    void endForegroundGeneration()
        .catch((error) => {
            warn('Error while ending foreground generation:', error);
        })
        .finally(() => {
            updateInjection();
            updateUI();
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

function onBeforeUnload() {
    recoverPromptFreeze('page unload');
}

function onWindowFocus() {
    recoverPromptFreeze('window focus');
}

function onVisibilityChange() {
    const doc = globalThis.document;
    if (!doc || doc.visibilityState === 'visible' || doc.hidden === false) {
        recoverPromptFreeze('tab visible');
    }
}

function recoverPromptFreeze(reason) {
    void recoverStalePromptFreeze(reason, { refreshUi: updateUI }).catch((error) => {
        warn('Error while recovering foreground generation freeze:', error);
    });
}

/** Normalize message IDs, refresh injection, then restore missing ghost flags. */
async function reconcileLoadedChatState() {
    const chat = getChat();
    if (ensureChatScIds(chat)) {
        await persistChatState();
    }
    getChatStore();
    await repairOrphanedMessages();
    updateInjection();
    await repairMissingGhostingForSummaries();
}

/**
 * Debounce loaded-chat reconciliation after chat save/load bursts.
 * @returns {void}
 */
function scheduleLoadedChatReconciliation() {
    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
    }
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void runSerializedReconciliation();
    }, 100);
}

/**
 * Run loaded-chat reconciliation serially, coalescing queued requests.
 * @returns {Promise<void>}
 */
async function runSerializedReconciliation() {
    if (reconcilePromise) {
        reconcileQueued = true;
        return await reconcilePromise;
    }

    reconcilePromise = drainReconciliationQueue();
    try {
        await reconcilePromise;
    } finally {
        reconcilePromise = null;
    }
}

/**
 * Drain one or more coalesced reconciliation requests.
 * @returns {Promise<void>}
 */
async function drainReconciliationQueue() {
    do {
        reconcileQueued = false;
        await reconcileLoadedChatState();
        updateUI();
    } while (reconcileQueued);
    await checkStaleCacheAdvice();
}

let staleCacheAdviceKey = '';

/**
 * Suggest an early Force Summarize when the loaded chat's provider cache is
 * stale. Shown once per queue state per page session.
 * @returns {Promise<void>}
 */
async function checkStaleCacheAdvice() {
    try {
        const settings = getEffectiveSettings();
        if (!settings.enabled || !isProviderCacheMode(settings) || hasActiveAbortController()) {
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
