import { persistChatState } from '../core/persist-state.js';
import { updateInjection } from './injection.js';

// ─── Chat State Persistence & Extension Refresh ─────────────────────

let _uiRefresher = null;

/**
 *
 */
export function setUiRefresher(fn) {
    _uiRefresher = fn;
}

export { persistChatState };

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
