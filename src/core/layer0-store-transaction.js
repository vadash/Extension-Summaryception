import { error } from '../foundation/logger.js';
import { saveChatStore } from '../foundation/state.js';

/**
 * Execute a Layer 0 store mutation and restore the pre-mutation state if post-commit effects fail.
 * @param {object} p
 * @param {SummaryceptionStore} p.store
 * @param {() => void} p.mutate
 * @param {() => Promise<void>} p.persist
 * @param {string} p.rollbackMessage
 * @param {() => void} [p.onRollback]
 * @returns {Promise<void>}
 */
export async function executeLayer0StoreTransaction({
    store,
    mutate,
    persist,
    rollbackMessage,
    onRollback,
}) {
    const rollbackPoint = captureLayer0RollbackPoint(store);

    try {
        mutate();
        await persist();
    } catch (err) {
        restoreLayer0RollbackPoint(store, rollbackPoint);
        onRollback?.();
        error(rollbackMessage, err);
        await saveChatStore();
        throw err;
    }
}

function captureLayer0RollbackPoint(store) {
    return {
        layer0: [...(store.layers[0] || [])],
        summarizedUpTo: store.summarizedUpTo,
        mutationEpoch: store.mutationEpoch,
    };
}

function restoreLayer0RollbackPoint(store, rollbackPoint) {
    store.layers[0] = rollbackPoint.layer0;
    store.summarizedUpTo = rollbackPoint.summarizedUpTo;
    store.mutationEpoch = rollbackPoint.mutationEpoch;
}
