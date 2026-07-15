import { getChat } from '../foundation/context.js';
import { debug, info, warn } from '../foundation/logger.js';
import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { repairIfBranched, repairMissingGhostingForSummaries } from '../core/ghosting-reconcile.js';
import { maskUserRoleAsAssistantInGenerateData } from '../core/assistant-role-mask.js';
import {
    beginForegroundGeneration,
    endForegroundGeneration,
    hasActiveAbortController,
    hasFrozenPromptMutations,
    maybeSummarizeTurns,
    recoverStalePromptFreeze,
    resetPromptMutationGuard,
} from '../core/summarizer.js';
import { updateInjection } from '../features/injection.js';
import { repairOrphanedMessages } from '../features/maintenance.js';
import { updateUI } from './ui.js';

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
                await maybeSummarizeTurns();
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
    const dryRun = args[2] === true;
    if (dryRun) {
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
 * @param {unknown} generateData - Mutable SillyTavern generation payload.
 * @param {unknown} _dryRun - Whether this is a prompt-inspection dry run.
 * @returns {void}
 */
export function onGenerateAfterData(generateData, _dryRun) {
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

/**
 * Normalize metadata, repair branch drift, refresh injection, then restore missing ghost flags.
 * @returns {Promise<void>}
 */
async function reconcileLoadedChatState() {
    getChatStore();
    await repairIfBranched();
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
}
