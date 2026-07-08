import { trace } from '../foundation/logger.js';
import { ELASTIC_STRATEGIES, runElasticManual } from './summarizer-engine.js';

/**
 * @typedef {import('./summarizer-engine.js').ManualRunOutcome} ManualRunOutcome
 * @typedef {import('./summarizer-engine.js').ManualRunProgress} ManualRunProgress
 */

/**
 * @typedef {object} ManualRunOptions
 * @property {AbortSignal} [signal] - Abort signal for cancelling the manual run.
 * @property {(progress: ManualRunProgress) => void} [onStart] - Called with initial progress.
 * @property {(progress: ManualRunProgress) => void} [onProgress] - Called after batch progress changes.
 */

/**
 * @typedef {object} ManualRunnerDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue - Shared summarizer queue.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 */

/**
 * Run the force-summarize catch-up loop.
 * @param {ManualRunnerDeps} deps
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {number} overflow
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runCatchup(deps, visibleTurns, overflow, options = {}) {
    return await deps.withUsageRun('force summarize catch-up', async () => {
        trace('>>> ENTERING runCatchup');
        trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
        trace('  overflow:', overflow);
        return await runElasticManual(deps, ELASTIC_STRATEGIES.FORCE, options);
    });
}

/**
 * Run Slop Breaker up to a fixed live-context cut.
 * @param {ManualRunnerDeps} deps
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runSlopBreaker(deps, options = {}) {
    return await deps.withUsageRun('slop breaker', async () => {
        return await runElasticManual(deps, ELASTIC_STRATEGIES.SLOP, options);
    });
}
