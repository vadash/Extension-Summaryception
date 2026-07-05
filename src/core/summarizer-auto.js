import { runElasticAutoCycle } from './summarizer-engine.js';

let catchupDismissed = false;
let autoBacklogNotifier = null;

/**
 * Register UI callbacks for automatic worker notices.
 * @param {{ showAutoBacklogNotice?: (plan: import('./verbatim-window.js').Layer0OverflowPlan) => void }} [notifiers]
 * @returns {void}
 */
export function setAutoWorkerNotifiers({ showAutoBacklogNotice } = {}) {
    autoBacklogNotifier = showAutoBacklogNotice || null;
}

/**
 * Reset the catch-up dismissed flag so the backlog notice can show again.
 * @returns {void}
 */
export function resetCatchupDismissed() {
    catchupDismissed = false;
}

/**
 * Run one automatic worker action against fresh chat state.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {{ refreshUi?: () => void }} [opts]
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
export async function runAutoWorkerCycle(queue, { refreshUi } = {}) {
    return await runElasticAutoCycle(queue, {
        refreshUi,
        showAutoBacklogNotice,
    });
}

/**
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
export async function yieldWorkerCycle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function showAutoBacklogNotice(plan) {
    if (catchupDismissed) {
        return;
    }

    catchupDismissed = true;
    autoBacklogNotifier?.(plan);
}
