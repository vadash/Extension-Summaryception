import { error } from '../foundation/logger.js';
import { refreshUi } from '../foundation/refresh.js';
import { getChatStore, isValidSnippet } from '../foundation/chat-store.js';
import { commitSnippetMutation } from '../core/snippet-commit.js';

// ─── Memory Import Workflow ──────────────────────────────────────────

/**
 * Rejects an invalid payload before getChatStore() touches chat metadata.
 * @param {any} data - Parsed JSON payload
 * @returns {boolean} True when the payload carries valid layers and ghosted IDs
 */
function validateImportPayload(data) {
    return (
        Array.isArray(data?.layers) &&
        Array.isArray(data.ghostedMessageIds) &&
        data.layers.every((layer) => Array.isArray(layer) && layer.every(isValidSnippet))
    );
}

/**
 * Unlike Clear, which throws to its caller, an invalid payload is a guard
 * rather than a fault. Every outcome arrives as a structured status for the
 * entry layer to notice.
 * @param {any} data - Parsed JSON payload
 * @param {{ notify?: import('../core/notify.js').NotifyAdapter, gate: import('../core/foreground-gate.js').ForegroundGate }} options - Import notices and the Foreground Gate the commit crosses.
 * @returns {Promise<{ status: 'imported', count: number } | { status: 'invalid' } | { status: 'failed', cause: unknown }>}
 */
export async function importSummaryceptionMemory(data, { notify, gate }) {
    if (!validateImportPayload(data)) {
        return { status: 'invalid' };
    }

    try {
        const store = getChatStore();
        await commitSnippetMutation(
            store,
            () => {
                store.layers = data.layers;
            },
            { notify, gate, chatSave: 'immediate' },
        );
        refreshUi();
        const count = store.layers.reduce((sum, layer) => sum + (layer?.length || 0), 0);
        return { status: 'imported', count };
    } catch (err) {
        error(err);
        return { status: 'failed', cause: err };
    }
}
