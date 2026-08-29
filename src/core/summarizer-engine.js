import { getChat } from '../foundation/context.js';
import { sleep } from '../foundation/retry.js';
import {
    getChatStore,
    getCurrentSummarizedBoundary,
    getEffectiveSettings,
} from '../foundation/state.js';
import { debug, info, trace } from '../foundation/logger.js';
import { summarizeAtomicLayer0Partitions, summarizeBatchFromTurns } from './summarizer-batch.js';
import {
    drainPromotionOverflow,
    hasPromotionOverflow,
    maybePromoteLayer,
} from './summarizer-promotion.js';
import { flushPendingChatSave } from './persist-state.js';
import { recoverStalePromptFreeze, shouldStopPromptWork } from './summarizer-commit.js';
import { formatTokenValue } from './token-count.js';
import {
    SUMMARY_COMMIT_MODES,
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from './summarization-routes.js';
import { prepareSummaryCycle } from './summary-preflight.js';
export const ELASTIC_STRATEGIES = Object.freeze({
    AUTO: 'AUTO',
    FORCE: 'FORCE',
    SLOP: 'SLOP',
    CACHE: 'CACHE',
});

/**
 * @typedef {object} ManualRunOutcome
 * @property {boolean} cancelled - Whether the manual run was cancelled.
 * @property {boolean} blocked - Whether the prompt guard blocked completion.
 * @property {number} completed - Number of committed batches.
 * @property {number} failed - Number of failed batches.
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {boolean} fullyCommitted - Whether all requested work was committed and normalized.
 * @property {boolean} shouldReload - Whether the caller should reload chat/UI state.
 * @property {boolean} failureLimitReached - Whether consecutive failures halted the run.
 */

/**
 * @typedef {object} ManualRunProgress
 * @property {number} completed - Number of committed batches so far.
 * @property {number} failed - Number of failed batches so far.
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {string} label - Short progress label for the active operation.
 * @property {string} title - User-visible progress title.
 */

/**
 * @typedef {object} ManualRunOptions
 * @property {AbortSignal} [signal] - Abort signal for cancelling the manual run.
 * @property {(progress: ManualRunProgress) => void} [onStart] - Called with initial progress.
 * @property {(progress: ManualRunProgress) => void} [onProgress] - Called after batch progress changes.
 */

/**
 * @typedef {object} ManualTask
 * @property {string} kind - Manual strategy identifier.
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {string} label - Short progress label for the active operation.
 * @property {string} title - User-visible progress title.
 * @property {number} targetIndex - Summarized boundary the run must reach.
 * @property {() => Promise<*>} getBatch - Builds the next route plan to commit.
 * @property {(batch: *) => boolean} isBatchReady - Whether a route plan has work.
 * @property {(batch: *) => Promise<{ success: boolean, committed: boolean, done?: boolean }>} processBatch - Commits one route plan.
 * @property {(outcome: ManualRunOutcome, task: ManualTask) => boolean} isComplete - Whether the run reached its target.
 */

/**
 * @typedef {object} ManualRunnerDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue - Shared summarizer queue.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 */

/**
 * Run one automatic elastic summarization action.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {{ refreshUi?: () => void }} [opts]
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
export async function runElasticAutoCycle(queue, { refreshUi } = {}) {
    await recoverStalePromptFreeze('auto worker', { refreshUi });

    if (shouldStopPromptWork()) {
        queue.setPhase('paused');
        return 'blocked';
    }

    const s = getEffectiveSettings();
    if (!s.enabled || s.autoPaused) {
        queue.setPhase('paused');
        return 'idle';
    }

    const prepared = await prepareSummaryCycle();
    if (await hasPromotionOverflow(0)) {
        queue.setPhase('promoting');
        const promotionResult = await processPromotionCycle({ overflowKnown: true });
        return promotionResult;
    }

    const routePlan = await buildAutoSummaryRoutePlan(prepared.chat, prepared.store, s);
    logRoutePlan(routePlan, s);

    if (!routePlan.ready) {
        return 'idle';
    }

    queue.setPhase(routePlan.phase);
    return await processRoutePlan(routePlan);
}
/**
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
export async function yieldWorkerCycle() {
    await sleep(0);
}

/**
 * Run the force-summarize catch-up loop.
 * The engine builds its own force route plan; callers only pass run options.
 * @param {ManualRunnerDeps} deps
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runCatchup(deps, options = {}) {
    return await deps.withUsageRun('force summarize catch-up', async () => {
        trace('>>> ENTERING runCatchup');
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

/**
 * Run Force Summarize or Slop Breaker through the shared engine.
 * @param {ManualRunnerDeps} deps
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runElasticManual(deps, strategy, options = {}) {
    if (!(await prepareManualRun(deps, `manual ${strategy.toLowerCase()}`))) {
        return createManualRunOutcome({ blocked: true });
    }

    const prepared = await prepareSummaryCycle();
    const task = await buildManualTask(strategy, prepared);
    if (!task) {
        return createManualRunOutcome();
    }

    const outcome = await executeManualTask(deps, task, options);
    const normalized = await normalizeManualMemory(outcome);
    deps.refreshUi();
    return {
        ...outcome,
        blocked: outcome.blocked || normalized === 'blocked',
        fullyCommitted: isManualRunComplete(outcome, task) && normalized === 'normalized',
        shouldReload: isManualRunComplete(outcome, task) && normalized === 'normalized',
    };
}

async function processRoutePlan(routePlan) {
    const success = await commitRoutePlan(routePlan, {
        showToasts: true,
        catchExceptions: true,
    });

    if (!success) {
        debug('Route batch failed, stopping summarization cycle to avoid retry loop.');
        return 'failed';
    }
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    return 'processed';
}

/**
 * Commit one normalized route plan.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {{ showToasts?: boolean, catchExceptions?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function commitRoutePlan(routePlan, options = {}) {
    if (routePlan.commitMode === SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS) {
        return await summarizeAtomicLayer0Partitions(routePlan.partitions, options);
    }
    if (routePlan.commitMode === SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END) {
        return await summarizeBatchFromTurns(routePlan.batchTurns, {
            ...options,
            sourceEndIdx: routePlan.sourceEndIdx,
        });
    }
    return await summarizeBatchFromTurns(routePlan.batchTurns, options);
}

async function processPromotionCycle({ overflowKnown = false } = {}) {
    const hadOverflow = overflowKnown || (await hasPromotionOverflow(0));
    if (!hadOverflow) {
        return 'idle';
    }

    const promoted = await maybePromoteLayer(0);
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    if (promoted) {
        return 'processed';
    }
    return hadOverflow ? 'failed' : 'idle';
}

const MANUAL_STRATEGIES = Object.freeze({
    [ELASTIC_STRATEGIES.FORCE]: {
        buildTask: buildForceTask,
        processBatch: processForceBatch,
        isComplete: (_outcome, task) =>
            getCurrentSummarizedBoundary(getChat(), getChatStore()) >= task.targetIndex,
    },
    [ELASTIC_STRATEGIES.SLOP]: {
        buildTask: buildSlopTask,
        processBatch: processSlopBatch,
        isComplete: (_outcome, task) =>
            getCurrentSummarizedBoundary(getChat(), getChatStore()) >= task.targetIndex,
    },
});

/**
 * Build the manual task for one strategy.
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} prepared
 * @returns {Promise<ManualTask | null | undefined>}
 */
async function buildManualTask(strategy, prepared) {
    const manualStrategy = MANUAL_STRATEGIES[strategy];
    return await manualStrategy?.buildTask(manualStrategy, prepared);
}

/**
 * @param {*} strategy
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} prepared
 * @returns {Promise<ManualTask | null>}
 */
async function buildForceTask(strategy, prepared) {
    const initialRoutePlan = await getForceRoutePlan(prepared);
    if (!initialRoutePlan.ready) {
        return null;
    }

    return {
        kind: ELASTIC_STRATEGIES.FORCE,
        totalBatches: initialRoutePlan.totalBatches,
        label: 'Processing',
        title: 'Summaryception Catch-Up',
        targetIndex: initialRoutePlan.rawPlan.queuedEndIdx,
        getBatch: getForceRoutePlan,
        isBatchReady: (batch) => batch?.ready,
        processBatch: strategy.processBatch,
        isComplete: strategy.isComplete,
    };
}

/**
 * @param {*} strategy
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} prepared
 * @returns {Promise<ManualTask | null>}
 */
async function buildSlopTask(strategy, prepared) {
    const initialRoutePlan = await buildSlopSummaryRoutePlan(
        prepared.chat,
        prepared.store,
        getEffectiveSettings(),
    );
    const targetIndex = initialRoutePlan.targetIndex;
    if (!initialRoutePlan.ready || typeof targetIndex !== 'number') {
        return null;
    }

    return {
        kind: ELASTIC_STRATEGIES.SLOP,
        totalBatches: initialRoutePlan.totalBatches,
        label: 'Breaking slop',
        title: 'Summaryception Slop Breaker',
        targetIndex,
        getBatch: async () => {
            const cycle = await prepareSummaryCycle();
            return await buildSlopSummaryRoutePlan(
                cycle.chat,
                cycle.store,
                getEffectiveSettings(),
                {
                    targetIndex,
                },
            );
        },
        isBatchReady: (batch) => batch?.ready,
        processBatch: strategy.processBatch,
        isComplete: strategy.isComplete,
    };
}

/**
 * Drive one manual task batch loop to completion.
 * @param {ManualRunnerDeps} deps
 * @param {ManualTask} task
 * @param {ManualRunOptions} options
 * @returns {Promise<ManualRunOutcome>}
 */
async function executeManualTask(deps, task, options) {
    const outcome = createManualRunOutcome({ totalBatches: task.totalBatches });
    let consecutiveFailures = 0;

    options.onStart?.(createProgress(outcome, task));
    deps.queue.setSummarizing(true);

    try {
        while (!isCancelled(options.signal)) {
            const batch = await task.getBatch();
            if (!task.isBatchReady(batch)) {
                break;
            }

            const result = await task.processBatch(batch);
            updateManualOutcome({ outcome, result });
            consecutiveFailures = result.success && result.committed ? 0 : consecutiveFailures;

            if ((await normalizeAfterCommittedResult(outcome, result)) === 'failed') {
                break;
            }

            if (shouldStopManualLoop(outcome, result, options.signal, deps.queue)) {
                break;
            }

            consecutiveFailures = updateConsecutiveFailures(outcome, result, consecutiveFailures);
            if (outcome.failureLimitReached) {
                break;
            }

            options.onProgress?.(createProgress(outcome, task));
            await sleep(200);
        }

        if (isCancelled(options.signal)) {
            outcome.cancelled = true;
        }
        return outcome;
    } finally {
        deps.queue.setSummarizing(false);
        await flushPendingChatSave();
    }
}

async function normalizeAfterCommittedResult(outcome, result) {
    if (!result.success || !result.committed || outcome.blocked) {
        return 'skipped';
    }

    const normalized = await normalizePromotions();
    if (normalized === 'blocked') {
        outcome.blocked = true;
    } else if (normalized === 'failed') {
        outcome.failed++;
    }
    return normalized;
}

function updateConsecutiveFailures(outcome, result, consecutiveFailures) {
    if (result.success) {
        return consecutiveFailures;
    }

    const failures = consecutiveFailures + 1;
    outcome.failureLimitReached = failures >= 3;
    return failures;
}

function updateManualOutcome({ outcome, result }) {
    if (result.success && result.committed) {
        outcome.completed++;
        if (shouldStopPromptWork()) {
            outcome.blocked = true;
        }
    } else if (result.success) {
        outcome.blocked = true;
    } else {
        outcome.failed++;
    }
}

function shouldStopManualLoop(outcome, result, signal, queue) {
    if (result.done || outcome.blocked) {
        return true;
    }
    if (isCancelled(signal) || !queue.getIsSummarizing()) {
        outcome.cancelled = true;
        return true;
    }
    return false;
}

async function processForceBatch(plan) {
    trace('Processing force batch via elastic engine');
    const beforeIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    const success = await commitRoutePlan(plan, { catchExceptions: true });
    const afterIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    return {
        success,
        committed: success && afterIndex > beforeIndex,
    };
}

async function processSlopBatch(plan) {
    const success = await commitRoutePlan(plan, { catchExceptions: true });
    const afterIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    return {
        success,
        committed: success && afterIndex >= plan.sourceEndIdx,
        done: afterIndex >= plan.targetIndex,
    };
}

async function getForceRoutePlan(prepared) {
    const cycle = prepared || (await prepareSummaryCycle());
    const plan = await buildForceSummaryRoutePlan(cycle.chat, cycle.store, getEffectiveSettings());

    trace(`Current visible turns: ${plan.rawPlan.visibleTurnCount}, plan reason: ${plan.reason}`);
    return plan;
}

async function normalizeManualMemory(outcome) {
    if (outcome.cancelled || outcome.blocked || outcome.completed === 0 || outcome.failed > 0) {
        return 'skipped';
    }
    if (shouldStopPromptWork()) {
        info('Manual promotion deferred; prompt mutation guard is active.');
        return 'blocked';
    }
    return await normalizePromotions();
}

async function normalizePromotions() {
    return await drainPromotionOverflow({ maxFailures: 3, isBlockedAfter: shouldStopPromptWork });
}

function isManualRunComplete(outcome, task) {
    if (outcome.cancelled || outcome.blocked || outcome.failed > 0 || outcome.completed === 0) {
        return false;
    }
    return task.isComplete(outcome, task);
}

async function prepareManualRun(deps, recoverReason) {
    await recoverStalePromptFreeze(recoverReason, { refreshUi: deps.refreshUi });
    return !shouldStopPromptWork();
}

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

function createProgress(outcome, task) {
    return {
        completed: outcome.completed,
        failed: outcome.failed,
        totalBatches: outcome.totalBatches,
        label: task.label,
        title: task.title,
    };
}

function isCancelled(signal) {
    return Boolean(signal?.aborted);
}

function logRoutePlan(routePlan, s) {
    const plan = routePlan.rawPlan;
    debug(
        `Mode: ${s.memoryMode}, recent: ${formatTokenValue(plan.verbatimTokens)}/` +
            `${formatTokenValue(plan.verbatimBudget)}, queued: ${formatTokenValue(plan.queuedTokens)}/` +
            `${formatTokenValue(plan.queuedBudget)}, partitions: ${plan.partitions.length}`,
    );
}
