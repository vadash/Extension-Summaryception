import { log } from './logger.js';
import { repairIfBranched } from './ghosting.js';
import { maybeSummarizeTurns, resetCatchupDismissed } from './summarizer.js';
import { updateInjection } from './injection.js';
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
                updateInjection();
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
        await repairIfBranched();
        updateInjection();
        updateUI();
    }, 100);
}

/**
 *
 */
export function onGenerationStarted() {
    updateInjection();
}
