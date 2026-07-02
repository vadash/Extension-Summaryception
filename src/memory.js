import { LOG_PREFIX, MODULE_NAME } from './constants.js';
import { log } from './logger.js';
import { getChatStore } from './state.js';
import { unghostAllMessages } from './ghosting.js';
import { persistAndRefresh } from './persist.js';

// ─── Memory Clear Workflow ───────────────────────────────────────────

/**
 * Clear all Summaryception memory for the current chat and unghost all messages.
 * Shared between the UI button handler and the /sc-clear slash command.
 * @param {{ updateUi?: boolean }} [opts]
 */
export async function clearSummaryceptionMemory(
    /** @type {{ updateUi?: boolean }} */ { updateUi = false } = {},
) {
    try {
        await unghostAllMessages();
    } catch (e) {
        console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
        toastr.warning(
            'Some messages could not be unghosted, but memory will still be cleared.',
            'Summaryception',
        );
    }

    const store = getChatStore();
    store.layers.length = 0;
    store.summarizedUpTo = -1;
    store.ghostedIndices = [];

    const { chatMetadata } = SillyTavern.getContext();
    chatMetadata[MODULE_NAME] = store;

    await persistAndRefresh({ injection: true, ui: updateUi });
    log('Memory cleared & messages unghosted.');
}
