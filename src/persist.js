import { saveChatStore } from './state.js';
import { updateInjection } from './injection.js';
import { log } from './logger.js';

// ─── Chat State Persistence & Extension Refresh ─────────────────────

let _uiRefresher = null;

/**
 *
 */
export function setUiRefresher(fn) {
    _uiRefresher = fn;
}

/**
 * Persist chat metadata and chat state in one step.
 * Equivalent to: saveChatStore() + ctx.saveChat().
 */
export async function persistChatState() {
    await saveChatStore();
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.saveChat) {
            await ctx.saveChat();
        }
    } catch (e) {
        log('Could not save chat:', e);
    }
}

/**
 * Refresh extension state after a mutation.
 * @param {{ injection?: boolean, ui?: boolean }} [opts]
 */
export function refreshExtensionState(
    /** @type {{ injection?: boolean, ui?: boolean }} */ { injection = true, ui = false } = {},
) {
    if (injection) {
        updateInjection();
    }
    if (ui && _uiRefresher) {
        _uiRefresher();
    }
}

/**
 * Persist chat state then refresh extension state.
 * @param {{ injection?: boolean, ui?: boolean }} [opts]
 */
export async function persistAndRefresh(
    /** @type {{ injection?: boolean, ui?: boolean }} */ { injection = true, ui = false } = {},
) {
    await persistChatState();
    refreshExtensionState({ injection, ui });
}
