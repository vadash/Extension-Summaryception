import { log } from '../foundation/logger.js';
import { getChatStore } from '../foundation/state.js';
import { repairIfBranched, repairMissingGhostingForSummaries } from '../core/ghosting-reconcile.js';
import {
    beginForegroundGeneration,
    endForegroundGeneration,
    hasActiveAbortController,
    hasFrozenPromptMutations,
    maybeSummarizeTurns,
    resetCatchupDismissed,
} from '../core/summarizer.js';
import { updateInjection } from '../features/injection.js';
import { updateUI } from './ui.js';

// ─── Event Handlers ──────────────────────────────────────────────────

/**
 *
 */
export function onMessageReceived(messageIndex) {
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await maybeSummarizeTurns();
                updateUI();
            }, 500);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

/**
 *
 */
export function onChatChanged() {
    log('Chat changed.');
    resetCatchupDismissed();
    setTimeout(async () => {
        await reconcileLoadedChatState();
        updateUI();
    }, 100);
}

/**
 * Reconcile persisted Summaryception state after app load.
 * @returns {Promise<void>}
 */
export async function onAppReady() {
    await reconcileLoadedChatState();
    updateUI();
}

/**
 *
 */
export function onGenerationStarted() {
    if (hasActiveAbortController()) {
        log('Ignoring generation start from active Summaryception request.');
        return;
    }
    log('Foreground generation start detected; freezing Summaryception prompt mutations.');
    beginForegroundGeneration();
}

/**
 *
 */
export function onGenerationEnded() {
    const hasActiveSummaryRequest = hasActiveAbortController();
    const hasFrozenMutations = hasFrozenPromptMutations();

    if (hasActiveSummaryRequest && !hasFrozenMutations) {
        log('Ignoring generation end from active Summaryception request.');
        return;
    }

    log(
        'Generation end detected; flushing Summaryception prompt mutations.',
        `activeSummaryRequest=${hasActiveSummaryRequest}`,
        `frozen=${hasFrozenMutations}`,
    );
    void endForegroundGeneration().then(() => {
        updateInjection();
        updateUI();
    });
}

/**
 * Normalize metadata, repair branch drift, refresh injection, then restore missing ghost flags.
 * @returns {Promise<void>}
 */
async function reconcileLoadedChatState() {
    getChatStore();
    await repairIfBranched();
    updateInjection();
    await repairMissingGhostingForSummaries();
}
