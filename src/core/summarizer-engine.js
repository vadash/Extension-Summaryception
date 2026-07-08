import { MEMORY_MODES } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { debug, info, trace } from '../foundation/logger.js';
import { getCacheFriendlyPlan } from './cache-planner.js';
import { summarizeBatchFromTurns } from './summarizer-batch.js';
import { maybePromoteLayer, hasPromotionOverflow } from './summarizer-promotion.js';
import { getLayer0OverflowPlan } from './verbatim-window.js';
import { getSlopBreakerPlan } from './slop-breaker.js';
import { flushPendingChatSave } from './persist-state.js';
import { recoverStalePromptFreeze, shouldStopPromptWork } from './summarizer-commit.js';
import { formatTokenValue } from './token-count.js';

export const ELASTIC_STRATEGIES = Object.freeze({
    AUTO: 'AUTO',
    FORCE: 'FORCE',
    SLOP: 'SLOP',
    CACHE: 'CACHE',
});

/**
 * @typedef {object} ManualRunOutcome
 * @property {boolean} cancelled
 * @property {boolean} blocked
 * @property {number} completed
 * @property {number} failed
 * @property {number} totalBatches
 * @property {boolean} fullyCommitted
 * @property {boolean} shouldReload
 * @property {boolean} failureLimitReached
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

    const s = getSettings();
    if (!s.enabled) {
        queue.setPhase('paused');
        return 'idle';
    }

    if (await hasPromotionOverflow(0)) {
        queue.setPhase('promoting');
        const promotionResult = await processPromotionCycle({ overflowKnown: true });
        return promotionResult;
    }

    if (s.memoryMode === MEMORY_MODES.CACHE) {
        return await runElasticCacheCycle(queue, s);
    }

    const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), s);
    logOverflowPlan(plan, s);

    if (plan.reason !== 'none') {
        queue.setPhase('layer0');
        return await processLayer0Plan(plan);
    }

    return 'idle';
}

/**
 * Run Force Summarize or Slop Breaker through the shared engine.
 * @param {object} deps
 * @param {import('./summarizer-queue.js').SummarizerQueue} deps.queue
 * @param {() => void} deps.refreshUi
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {{ signal?: AbortSignal, onStart?: (progress: ManualRunProgress) => void, onProgress?: (progress: ManualRunProgress) => void }} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runElasticManual(deps, strategy, options = {}) {
    if (!(await prepareManualRun(deps, `manual ${strategy.toLowerCase()}`))) {
        return createManualRunOutcome({ blocked: true });
    }

    const task = await buildManualTask(strategy, options);
    if (!task) {
        return createManualRunOutcome();
    }

    const outcome = await executeManualTask(deps, task);
    const normalized = await normalizeManualMemory(outcome);
    deps.refreshUi();
    return {
        ...outcome,
        blocked: outcome.blocked || normalized === 'blocked',
        fullyCommitted: isManualRunComplete(outcome, task) && normalized === 'normalized',
        shouldReload: isManualRunComplete(outcome, task) && normalized === 'normalized',
    };
}

async function runElasticCacheCycle(queue, s) {
    const plan = await getCacheFriendlyPlan(getChat(), getChatStore(), s);
    logCachePlan(plan);

    if (plan.reason !== 'ready') {
        return 'idle';
    }

    queue.setPhase('layer0');
    return await processCacheLayer0Plan(plan);
}

/**
 * Process one Layer 0 plan.
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} plan
 * @returns {Promise<'processed' | 'blocked' | 'failed'>}
 */
async function processLayer0Plan(plan) {
    const turns = plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
    return await processLayer0Turns(turns);
}

/**
 * Process one cache-delayed Layer 0 batch.
 * @param {import('./cache-planner.js').CacheFriendlyPlan} plan
 * @returns {Promise<'processed' | 'blocked' | 'failed'>}
 */
async function processCacheLayer0Plan(plan) {
    return await processLayer0Turns(plan.batchTurns);
}

/**
 * Process one Layer 0 summarization call.
 * @param {import('./chatutils.js').AssistantTurn[]} turns
 * @returns {Promise<'processed' | 'blocked' | 'failed'>}
 */
async function processLayer0Turns(turns) {
    const success = await summarizeBatchFromTurns(turns, {
        showToasts: false,
        catchExceptions: true,
    });

    if (!success) {
        debug('Batch failed, stopping summarization cycle to avoid retry loop.');
        return 'failed';
    }
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    return 'processed';
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
        isComplete: () => true,
    },
    [ELASTIC_STRATEGIES.SLOP]: {
        buildTask: buildSlopTask,
        processBatch: processSlopBatch,
        isComplete: (_outcome, task) => getChatStore().summarizedUpTo >= task.targetIndex,
    },
});

async function buildManualTask(strategy, options) {
    const manualStrategy = MANUAL_STRATEGIES[strategy];
    return await manualStrategy?.buildTask(options, manualStrategy);
}

async function buildForceTask(options, strategy) {
    const initialPlan = await getForcePlan();
    if (!initialPlan) {
        return null;
    }

    return {
        kind: ELASTIC_STRATEGIES.FORCE,
        totalBatches: estimateForceBatches(initialPlan),
        label: 'Processing',
        title: 'Summaryception Catch-Up',
        options,
        targetIndex: initialPlan.tokenBoundaryIndex,
        getBatch: getForcePlan,
        isBatchReady: (batch) => Boolean(batch),
        processBatch: strategy.processBatch,
        isComplete: strategy.isComplete,
    };
}

function buildSlopTask(options, strategy) {
    const initialPlan = getSlopBreakerPlan(getChat(), getChatStore(), getSettings());
    if (initialPlan.reason !== 'ready') {
        return null;
    }

    const targetIndex = initialPlan.targetIndex;
    return {
        kind: ELASTIC_STRATEGIES.SLOP,
        totalBatches: initialPlan.totalBatches,
        label: 'Breaking slop',
        title: 'Summaryception Slop Breaker',
        options,
        targetIndex,
        getBatch: () =>
            getSlopBreakerPlan(getChat(), getChatStore(), getSettings(), { targetIndex }),
        isBatchReady: (batch) => batch?.reason === 'ready',
        processBatch: strategy.processBatch,
        isComplete: strategy.isComplete,
    };
}

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
            updateManualOutcome({ outcome, result });
            consecutiveFailures = result.success && result.committed ? 0 : consecutiveFailures;

            if (result.success && result.committed && !outcome.blocked) {
                const normalized = await normalizePromotions();
                if (normalized === 'blocked') {
                    outcome.blocked = true;
                } else if (normalized === 'failed') {
                    outcome.failed++;
                    break;
                }
            }

            if (shouldStopManualLoop(outcome, result, task.options.signal, deps.queue)) {
                break;
            }
            if (!result.success) {
                consecutiveFailures++;
                outcome.failureLimitReached = consecutiveFailures >= 3;
                if (outcome.failureLimitReached) {
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
    const beforeIndex = getChatStore().summarizedUpTo;
    const turns = plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
    const success = await summarizeBatchFromTurns(turns, { catchExceptions: true });
    return {
        success,
        committed: success && getChatStore().summarizedUpTo > beforeIndex,
    };
}

async function processSlopBatch(plan) {
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

async function getForcePlan() {
    const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), getSettings(), {
        ignoreReadiness: true,
    });

    trace(`Current visible turns: ${plan.visibleTurnCount}, plan reason: ${plan.reason}`);
    return plan.reason === 'none' ? null : plan;
}

function estimateForceBatches(plan) {
    const batchLimit = Math.max(1, getSettings().maxSummaryTurns);
    const readyTurns = plan.batchTurns.length + plan.softOverflowCount;
    return Math.max(1, Math.ceil(readyTurns / batchLimit));
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
    let failures = 0;
    while (await hasPromotionOverflow(0)) {
        const promoted = await maybePromoteLayer(0);
        if (shouldStopPromptWork()) {
            return 'blocked';
        }
        if (promoted) {
            failures = 0;
        } else {
            failures++;
            if (failures >= 3) {
                return 'failed';
            }
        }
    }
    return 'normalized';
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

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function logOverflowPlan(plan, s) {
    debug(
        `Visible assistant turns: ${plan.visibleTurnCount}, max batch: ${s.maxSummaryTurns}, ` +
            `verbatim budget: ${formatTokenValue(plan.budgetStats.finalTokens)}/` +
            `${formatTokenValue(s.verbatimTokenBudget)} tokens, ` +
            `summary budget: ${formatTokenValue(plan.summaryStats.finalTokens)}/` +
            `${formatTokenValue(s.minSummaryBudget)} tokens`,
    );
}

function logCachePlan(plan) {
    debug(
        `Cache mode live tokens: ${formatTokenValue(plan.liveTokens)}/` +
            `${formatTokenValue(plan.cacheBudget)}, ` +
            `protected tail: ${formatTokenValue(plan.protectedTailTokens)}, ` +
            `flush: ${formatTokenValue(plan.estimatedFlushTokens)}, ` +
            `batch: ${plan.batchTurns.length}`,
    );
}
