import { runElasticAutoCycle } from './summarizer-engine.js';

/**
 * Run one automatic worker action against fresh chat state.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {{ refreshUi?: () => void }} [opts]
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
export async function runAutoWorkerCycle(queue, { refreshUi } = {}) {
    return await runElasticAutoCycle(queue, { refreshUi });
}

/**
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
export async function yieldWorkerCycle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
