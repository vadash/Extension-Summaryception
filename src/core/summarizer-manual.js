import { getChat } from '../foundation/context.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { summarizeBatchFromTurns, summarizeOneBatchFromTurns } from './summarizer-batch.js';
import { maybePromoteLayer } from './summarizer-promotion.js';
import { getLayer0OverflowPlan } from './verbatim-window.js';
import { flushPendingChatSave } from './persist-state.js';
import { getSlopBreakerPlan } from './slop-breaker.js';
import { recoverStalePromptFreeze, shouldStopPromptWork } from './summarizer-commit.js';

/**
 * @typedef {object} ManualRunOutcome
 * @property {boolean} cancelled - Whether the user aborted the run
 * @property {boolean} blocked - Whether prompt guard state blocked the run
 * @property {number} completed - Number of committed batches
 * @property {number} failed - Number of failed batches
 * @property {number} totalBatches - Estimated batch count
 * @property {boolean} fullyCommitted - Whether the intended manual cut completed
 * @property {boolean} shouldReload - Whether the browser should reload
 * @property {boolean} failureLimitReached - Whether 3 consecutive failures stopped the run
 */

/**
 * @typedef {object} ManualRunOptions
 * @property {AbortSignal} [signal]
 * @property {(progress: ManualRunProgress) => void} [onStart]
 * @property {(progress: ManualRunProgress) => void} [onProgress]
 */

/**
 * @typedef {object} ManualRunProgress
 * @property {number} completed
 * @property {number} failed
 * @property {number} totalBatches
 * @property {string} label
 * @property {string} title
 */

/**
 * @typedef {object} ManualRunnerDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue
 * @property {() => void} refreshUi
 * @property {<T>(label: string, callback: () => Promise<T>) => Promise<T>} withUsageRun
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

        if (!(await prepareManualRun(deps, 'manual catch-up'))) {
            return createManualRunOutcome({ blocked: true });
        }

        const initialPlan = await getCatchupPlan();
        if (!initialPlan) {
            return createManualRunOutcome();
        }

        const totalBatches = estimateCatchupBatches(initialPlan);
        trace('  totalBatches calculated:', totalBatches);

        const outcome = await executeManualTask(deps, {
            totalBatches,
            label: 'Processing',
            title: 'Summaryception Catch-Up',
            options,
            getBatch: getCatchupPlan,
            isBatchReady: (batch) => Boolean(batch),
            processBatch: processCatchupBatch,
        });

        await maybePromoteAfterCatchup(outcome.cancelled);
        deps.refreshUi();
        return {
            ...outcome,
            fullyCommitted:
                !outcome.cancelled &&
                !outcome.blocked &&
                outcome.failed === 0 &&
                outcome.completed > 0,
            shouldReload: !outcome.cancelled && !outcome.blocked && outcome.completed > 0,
        };
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
        if (!(await prepareManualRun(deps, 'manual slop breaker'))) {
            return createManualRunOutcome({ blocked: true });
        }

        const initialPlan = getSlopBreakerPlan(getChat(), getChatStore(), getSettings());
        if (initialPlan.reason !== 'ready') {
            return createManualRunOutcome();
        }

        const targetIndex = initialPlan.targetIndex;
        const outcome = await executeManualTask(deps, {
            totalBatches: initialPlan.totalBatches,
            label: 'Breaking slop',
            title: 'Summaryception Slop Breaker',
            options,
            getBatch: () =>
                getSlopBreakerPlan(getChat(), getChatStore(), getSettings(), { targetIndex }),
            isBatchReady: (batch) => batch?.reason === 'ready',
            processBatch: processSlopBreakerBatch,
        });
        const fullyCommitted =
            !outcome.cancelled && !outcome.blocked && getChatStore().summarizedUpTo >= targetIndex;
        deps.refreshUi();
        return {
            ...outcome,
            fullyCommitted,
            shouldReload: fullyCommitted,
        };
    });
}

/**
 * Execute a cancelable manual summarization task.
 * @param {ManualRunnerDeps} deps
 * @param {object} task
 * @param {number} task.totalBatches
 * @param {string} task.label
 * @param {string} task.title
 * @param {ManualRunOptions} task.options
 * @param {() => Promise<object | null> | object | null} task.getBatch
 * @param {(batch: object | null) => boolean} task.isBatchReady
 * @param {(batch: object) => Promise<{ success: boolean, committed: boolean, done?: boolean }>} task.processBatch
 * @returns {Promise<ManualRunOutcome>}
 */
async function executeManualTask(deps, task) {
    const outcome = createManualRunOutcome({ totalBatches: task.totalBatches });
    let consecutiveFailures = 0;

    task.options.onStart?.(createProgress(outcome, task));
    deps.queue.setSummarizing(true);

    try {
        while (!isCancelled(task.options.signal)) {
            const batch = await task.getBatch();
            if (!task.isBatchReady(batch)) {
                break;
            }

            const result = await task.processBatch(batch);
            if (result.success && result.committed) {
                outcome.completed++;
                consecutiveFailures = 0;
                if (result.done) {
                    break;
                }
                if (shouldStopPromptWork()) {
                    outcome.blocked = true;
                    break;
                }
            } else if (result.success) {
                outcome.blocked = true;
                break;
            } else {
                if (isCancelled(task.options.signal) || !deps.queue.getIsSummarizing()) {
                    outcome.cancelled = true;
                    break;
                }
                outcome.failed++;
                consecutiveFailures++;
                if (consecutiveFailures >= 3) {
                    outcome.failureLimitReached = true;
                    break;
                }
            }

            task.options.onProgress?.(createProgress(outcome, task));
            await sleep(200);
        }

        if (isCancelled(task.options.signal)) {
            outcome.cancelled = true;
        }
        return outcome;
    } finally {
        deps.queue.setSummarizing(false);
        await flushPendingChatSave();
    }
}

/**
 * Summarize one catch-up batch and report whether the cursor advanced.
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} plan
 * @returns {Promise<{ success: boolean, committed: boolean }>}
 */
async function processCatchupBatch(plan) {
    trace('  About to call summarizeOneBatchFromTurns...');
    const turns = plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
    const beforeIndex = getChatStore().summarizedUpTo;
    const success = await summarizeOneBatchFromTurns(turns);
    const committed = getChatStore().summarizedUpTo > beforeIndex;

    if (success && committed) {
        trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
    } else if (!success) {
        trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
    } else {
        trace('  Batch result queued or did not advance the summary cursor');
    }
    return { success, committed };
}

/**
 * Summarize one Slop Breaker batch and report target progress.
 * @param {import('./slop-breaker.js').SlopBreakerPlan} plan
 * @returns {Promise<{ success: boolean, committed: boolean, done: boolean }>}
 */
async function processSlopBreakerBatch(plan) {
    const success = await summarizeBatchFromTurns(plan.batchTurns, {
        catchExceptions: true,
        sourceEndIdx: plan.sourceEndIdx,
    });
    const afterIndex = getChatStore().summarizedUpTo;
    return {
        success,
        committed: success && afterIndex >= plan.sourceEndIdx,
        done: afterIndex >= plan.targetIndex,
    };
}

/**
 * Get the latest overflow plan for catch-up, or null when complete.
 * @returns {Promise<import('./verbatim-window.js').Layer0OverflowPlan | null>}
 */
async function getCatchupPlan() {
    const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), getSettings());

    trace(`  currentVisible turns: ${plan.visibleTurnCount}, plan reason: ${plan.reason}`);

    if (plan.reason === 'none') {
        trace('  Visible turns now within the dynamic window, breaking');
        return null;
    }

    return plan;
}

/**
 * Estimate catch-up progress from the first overflow snapshot.
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} plan
 * @returns {number}
 */
function estimateCatchupBatches(plan) {
    const batchLimit = Math.max(1, getSettings().maxSummaryTurns);
    const readyTurns = plan.batchTurns.length + plan.softOverflowCount;
    return Math.max(1, Math.ceil(readyTurns / batchLimit));
}

/**
 * Promote after catch-up only when prompt-affecting work is not already queued.
 * @param {boolean} cancelled - Whether the catch-up was cancelled by the user
 * @returns {Promise<void>}
 */
async function maybePromoteAfterCatchup(cancelled) {
    if (cancelled) {
        return;
    }
    if (shouldStopPromptWork()) {
        log('Catch-up promotion deferred; prompt mutation guard is active.');
        return;
    }
    await maybePromoteLayer(0);
}

/**
 * Recover stale guard state and block manual work during foreground generation.
 * @param {ManualRunnerDeps} deps
 * @param {string} recoverReason - Context for stale guard recovery logs
 * @returns {Promise<boolean>} True when manual work may proceed
 */
async function prepareManualRun(deps, recoverReason) {
    await recoverStalePromptFreeze(recoverReason, { refreshUi: deps.refreshUi });
    return !shouldStopPromptWork();
}

/**
 * Create an empty manual run outcome.
 * @param {Partial<ManualRunOutcome>} [overrides]
 * @returns {ManualRunOutcome}
 */
function createManualRunOutcome(overrides = {}) {
    return {
        cancelled: false,
        blocked: false,
        completed: 0,
        failed: 0,
        totalBatches: 0,
        fullyCommitted: false,
        shouldReload: false,
        failureLimitReached: false,
        ...overrides,
    };
}

/**
 * Create a progress payload from the current outcome.
 * @param {ManualRunOutcome} outcome
 * @param {{ label: string, title: string }} task
 * @returns {ManualRunProgress}
 */
function createProgress(outcome, task) {
    return {
        completed: outcome.completed,
        failed: outcome.failed,
        totalBatches: outcome.totalBatches,
        label: task.label,
        title: task.title,
    };
}

/**
 * Check whether a manual run has been cancelled.
 * @param {AbortSignal | undefined} signal
 * @returns {boolean}
 */
function isCancelled(signal) {
    return Boolean(signal?.aborted);
}

/**
 * Wait before the next manual batch.
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
