import { MODULE_NAME } from '../foundation/constants.js';
import { getChatMetadata } from '../foundation/context.js';
import { error, info } from '../foundation/logger.js';
import { bumpSummaryStoreMutationEpoch, getChatStore } from '../foundation/state.js';
import { unghostAllMessages } from '../core/ghosting.js';
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
        error('Error during unghost (continuing with clear):', e);
        toastr.warning(
            'Some messages could not be unghosted, but memory will still be cleared.',
            'Summaryception',
        );
    }

    const store = getChatStore();
    store.layers.length = 0;
    store.summarizedUpTo = -1;
    store.ghostedIndices = [];
    bumpSummaryStoreMutationEpoch(store);

    const chatMetadata = getChatMetadata();
    chatMetadata[MODULE_NAME] = store;

    await persistAndRefresh({ injection: true, ui: updateUi });
    info('Memory cleared & messages unghosted.');
}
