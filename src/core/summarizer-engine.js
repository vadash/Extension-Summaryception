import { getChat } from '../foundation/context.js';
import { sleep } from '../foundation/retry.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getEffectiveSettings, getSettings, saveSettings } from '../foundation/settings.js';
import { debug, info, trace, warn } from '../foundation/logger.js';
import { runLayer0 } from './layer0-run.js';
import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { drainPromotionOverflow } from './summarizer-promotion.js';
import { flushPendingChatSave } from './persist-state.js';
import { deriveManualRunOutcome } from './run-outcome.js';
import { formatTokenValue } from './token-count.js';
import {
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from './summarization-routes.js';
import { prepareSummaryCycle } from './summary-preflight.js';
export const ELASTIC_STRATEGIES = Object.freeze({
    FORCE: 'FORCE',
    SLOP: 'SLOP',
});

/** @typedef {import('./run-outcome.js').ManualRunOutcome} ManualRunOutcome */
/** @typedef {import('./run-outcome.js').ManualRunTally} ManualRunTally */

/**
 * @typedef {object} ManualRunProgress
 * @property {number} completed - Number of committed batches so far.
 * @property {number} failed - Number of failed batches so far.
 * @property {number} totalBatches - Estimated total batches for the run.
 */

/**
 * @typedef {object} ManualRunOptions
 * @property {AbortSignal} [signal] - Abort signal for cancelling the manual run.
 * @property {(progress: ManualRunProgress) => void} [onStart] - Called with initial progress.
 * @property {(progress: ManualRunProgress) => void} [onProgress] - Called after batch progress changes.
 * @property {import('./notify.js').NotifyAdapter} [notify] - Adapter for progress notices; absent runs stay silent.
 */

/**
 * @typedef {object} ManualRunnerDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue - Shared summarizer queue.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 * @property {import('./foreground-gate.js').ForegroundGate} gate - Foreground Gate every prompt mutation of the run crosses.
 */

/**
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {{ refreshUi?: () => void, notify?: import('./notify.js').NotifyAdapter, gate: import('./foreground-gate.js').ForegroundGate }} opts
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
export async function runElasticAutoCycle(queue, { refreshUi, notify, gate }) {
    if ((await gate.promptWorkGate('auto worker', { refreshUi })) === 'blocked') {
        queue.setPhase('paused');
        return { status: 'blocked' };
    }

    const s = getEffectiveSettings();
    if (!s.enabled || s.autoPaused) {
        queue.setPhase('paused');
        return { status: 'idle' };
    }

    const prepared = await prepareSummaryCycle();
    queue.setPhase('promoting');
    const promotion = await drainPromotionOverflow({ maxConsecutiveFailures: 1, notify, gate });
    if (promotion.attempts > 0 || promotion.status !== 'completed') {
        return promotion;
    }

    const routePlan = await buildAutoSummaryRoutePlan(prepared.chat, prepared.store, s);
    logRoutePlan(routePlan, s);

    if (!routePlan.ready) {
        return { status: 'idle' };
    }

    queue.setPhase('layer0');
    return await processRoutePlan(routePlan, notify, gate);
}

/**
 * Run Force Summarize or Slop Breaker through the shared engine.
 * The engine builds its own route plan; callers only pass run options.
 * @param {ManualRunnerDeps} deps
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runManual(deps, strategy, options = {}) {
    const manualStrategy = MANUAL_STRATEGIES[strategy];
    if (!manualStrategy) {
        return deriveManualRunOutcome(createManualRunTally());
    }
    return await deps.withUsageRun(manualStrategy.usageLabel, async () => {
        if (!(await prepareManualRun(deps, `manual ${strategy.toLowerCase()}`))) {
            return deriveManualRunOutcome({ ...createManualRunTally(), blocked: true });
        }

        const prepared = await prepareSummaryCycle();
        const initialRoutePlan = await manualStrategy.buildBatch(prepared);
        const targetIndex = initialRoutePlan.targetIndex;
        if (!initialRoutePlan.ready || typeof targetIndex !== 'number') {
            return deriveManualRunOutcome(createManualRunTally());
        }

        const tally = await executeManualTask(
            deps,
            manualStrategy,
            { targetIndex, totalBatches: initialRoutePlan.totalBatches },
            options,
        );
        const promotionStatus = await normalizeManualMemory(tally, options.notify, deps.gate);
        deps.refreshUi();
        return deriveManualRunOutcome(
            { ...tally, blocked: tally.blocked || promotionStatus === 'blocked' },
            {
                targetReached: isManualTargetReached(targetIndex),
                promotionCompleted: promotionStatus === 'completed',
            },
        );
    });
}

/**
 * @typedef {object} PauseLatchDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue - Shared summarizer queue: isBusy reports live work, stop settles it, request kicks the resume cycle.
 */

/**
 * Stop path for the pause latch: abort any live run, persist `autoPaused`, and
 * let the queue settle. Callers only map the returned status to a notice.
 * @param {PauseLatchDeps} deps
 * @returns {Promise<'paused' | 'already-paused' | 'idle'>}
 */
export async function pauseAutoSummarization(deps) {
    if (!deps.queue.isBusy()) {
        return getSettings().autoPaused ? 'already-paused' : 'idle';
    }
    deps.queue.stop();
    const s = getSettings();
    s.autoPaused = true;
    saveSettings();
    return 'paused';
}

/**
 * Resume path for the pause latch: clear `autoPaused` and fire-and-forget one
 * automatic cycle.
 * @param {PauseLatchDeps} deps
 * @returns {Promise<'resumed' | 'not-paused'>}
 */
export async function resumeAutoSummarization(deps) {
    const s = getSettings();
    if (!s.autoPaused) {
        return 'not-paused';
    }
    s.autoPaused = false;
    saveSettings();
    void deps.queue.request().catch((e) => warn('Resume-triggered summary failed:', e));
    return 'resumed';
}

/**
 * Describe the manual work one strategy would run, without preflight or side effects.
 * @param {'FORCE' | 'SLOP'} strategy
 * @returns {Promise<{ ready: boolean, backlog: number }>}
 */
export async function describeManualRun(strategy) {
    const manualStrategy = MANUAL_STRATEGIES[strategy];
    if (!manualStrategy) {
        return { ready: false, backlog: 0 };
    }
    // Synthetic prepared context: route planners are index-only, preflight is skipped.
    const plan = await manualStrategy.buildBatch({ chat: getChat(), store: getChatStore() });
    return {
        ready: plan.ready,
        backlog: Math.max(plan.batchTurns.length, plan.overflowCount),
    };
}

/**
 * Run a route plan and apply the auto-run gate on top of the run outcome. A run
 * that waited for the Foreground Gate or found no work is terminal, not failed.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter for automatic runs.
 * @param {import('./foreground-gate.js').ForegroundGate} gate - Foreground Gate the run crosses.
 * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
 */
async function processRoutePlan(routePlan, notify, gate) {
    const outcome = await runLayer0(routePlan, notify, gate);

    if (outcome.status === 'blocked' || outcome.status === 'idle') {
        return outcome;
    }
    if (outcome.status !== 'completed') {
        debug('Route batch failed, stopping summarization cycle to avoid retry loop.');
        return outcome;
    }
    if ((await gate.promptWorkGate('route plan')) === 'blocked') {
        return { ...outcome, status: 'blocked' };
    }
    return outcome;
}

const isManualTargetReached = (targetIndex) =>
    getCurrentSummarizedBoundary(getChat(), getChatStore()) >= targetIndex;

/**
 * Per-strategy manual run configuration. `assessCommit` turns the summarized
 * boundary movement around one batch commit into the batch result flags.
 * @typedef {object} ManualStrategy
 * @property {string} usageLabel - Usage accounting scope label for the run.
 * @property {(prepared?: { chat: ChatMessage[], store: SummaryceptionStore }, targetIndex?: number) => Promise<import('./summarization-routes.js').SummaryRoutePlan>} buildBatch - Builds the next route plan.
 * @property {(plan: import('./summarization-routes.js').SummaryRoutePlan, beforeIndex: number, afterIndex: number) => { committed: boolean, done?: boolean }} assessCommit - Boundary assessment for one committed batch.
 */

const MANUAL_STRATEGIES = Object.freeze({
    [ELASTIC_STRATEGIES.FORCE]: {
        usageLabel: 'force summarize catch-up',
        buildBatch: buildForceBatch,
        assessCommit: (_plan, beforeIndex, afterIndex) => ({
            committed: afterIndex > beforeIndex,
        }),
    },
    [ELASTIC_STRATEGIES.SLOP]: {
        usageLabel: 'slop breaker',
        buildBatch: buildSlopBatch,
        assessCommit: (plan, _beforeIndex, afterIndex) => ({
            committed: plan.sourceEndIdx !== undefined && afterIndex >= plan.sourceEndIdx,
            done: plan.targetIndex !== undefined && afterIndex >= plan.targetIndex,
        }),
    },
});

/**
 * Build the next Force Summarize route plan.
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} [prepared]
 * @returns {Promise<import('./summarization-routes.js').SummaryRoutePlan>}
 */
async function buildForceBatch(prepared) {
    const cycle = prepared || (await prepareSummaryCycle());
    const plan = await buildForceSummaryRoutePlan(cycle.chat, cycle.store, getEffectiveSettings());
    trace(`Current visible turns: ${plan.visibleTurnCount}, plan reason: ${plan.reason}`);
    return plan;
}

/**
 * Build the next Slop Breaker route plan. The first plan resolves its own cut;
 * later batches pin the same fixed target boundary.
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} [prepared]
 * @param {number} [targetIndex] Fixed chat index the run should summarize through.
 * @returns {Promise<import('./summarization-routes.js').SummaryRoutePlan>}
 */
async function buildSlopBatch(prepared, targetIndex) {
    const cycle = prepared || (await prepareSummaryCycle());
    return await buildSlopSummaryRoutePlan(
        cycle.chat,
        cycle.store,
        getEffectiveSettings(),
        typeof targetIndex === 'number' ? { targetIndex } : {},
    );
}

/**
 * Drive one manual run batch loop to completion.
 * @param {ManualRunnerDeps} deps
 * @param {ManualStrategy} strategy
 * @param {{ targetIndex: number, totalBatches: number }} target - Values captured from the initial route plan.
 * @param {ManualRunOptions} options
 * @returns {Promise<ManualRunTally>}
 */
async function executeManualTask(deps, strategy, target, options) {
    const tally = createManualRunTally({ totalBatches: target.totalBatches });
    let consecutiveFailures = 0;
    const runToken = deps.queue.beginRun('manual-run');

    try {
        options.onStart?.(createProgress(tally));

        while (!isCancelled(options.signal) && !runToken.isStopped()) {
            const batch = await strategy.buildBatch(undefined, target.targetIndex);
            if (!batch?.ready) {
                break;
            }

            const result = await processStrategyBatch(batch, strategy, options.notify, deps.gate);
            const step = await applyManualLoopStep({
                tally,
                result,
                signal: options.signal,
                runToken,
                notify: options.notify,
                gate: deps.gate,
                consecutiveFailures,
            });
            consecutiveFailures = step.consecutiveFailures;
            if (step.exit) {
                break;
            }

            if (result.committed) {
                deps.refreshUi();
            }

            options.onProgress?.(createProgress(tally));
            await sleep(200);
        }

        if (isCancelled(options.signal) || runToken.isStopped()) {
            tally.aborted = true;
        }
        return tally;
    } finally {
        runToken.end();
        await flushPendingChatSave();
    }
}

// Consecutive failed batches a manual run tolerates before halting.
const MANUAL_FAILURE_LIMIT = 3;

/**
 * The failure streak counts failed batches only: a committed batch resets it,
 * and a success whose boundary did not move preserves it.
 * @param {object} step - One loop step's inputs.
 * @param {import('./summarizer-queue.js').WorkGateRun} step.runToken - The run's work gate lease; a stopped lease detects external stops.
 * @param {ManualRunTally} step.tally - Run state updated in place.
 * @param {{ success: boolean, committed: boolean, blocked: boolean, done?: boolean }} step.result - Batch result flags.
 * @param {AbortSignal} [step.signal] - Cancellation signal for the run.
 * @param {import('./notify.js').NotifyAdapter} [step.notify] - Notify adapter for promotions.
 * @param {import('./foreground-gate.js').ForegroundGate} step.gate - Foreground Gate the loop step asks before continuing.
 * @param {number} step.consecutiveFailures - Failure streak before this step.
 * @returns {Promise<{ exit: boolean, consecutiveFailures: number }>} Exit decision and the updated streak.
 */
async function applyManualLoopStep({
    tally,
    result,
    signal,
    runToken,
    notify,
    gate,
    consecutiveFailures,
}) {
    if (result.blocked) {
        tally.blocked = true;
    } else if (result.success && result.committed) {
        tally.completed++;
        consecutiveFailures = 0;
        if ((await gate.promptWorkGate('manual outcome')) === 'blocked') {
            tally.blocked = true;
        }
    } else if (result.success) {
        // A completed run that moved nothing has no batch to count, so the loop
        // halts instead of re-planning the same work.
        tally.blocked = true;
    } else {
        tally.failed++;
    }

    if (result.success && result.committed) {
        const promotion = await normalizePromotions(notify, gate);
        if (promotion.status === 'blocked') {
            tally.blocked = true;
        } else if (promotion.status === 'failed') {
            tally.failed++;
            return { exit: true, consecutiveFailures };
        }
    }

    if (result.done || tally.blocked) {
        return { exit: true, consecutiveFailures };
    }
    if (isCancelled(signal) || runToken.isStopped()) {
        tally.aborted = true;
        return { exit: true, consecutiveFailures };
    }

    if (!result.success) {
        consecutiveFailures++;
        tally.failureLimitReached = consecutiveFailures >= MANUAL_FAILURE_LIMIT;
    }
    return { exit: tally.failureLimitReached, consecutiveFailures };
}

/**
 * Run one route plan through the strategy's boundary assessment.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} plan
 * @param {ManualStrategy} strategy
 * @param {import('./notify.js').NotifyAdapter | undefined} notify
 * @param {import('./foreground-gate.js').ForegroundGate} gate
 * @returns {Promise<{ success: boolean, committed: boolean, blocked: boolean, done?: boolean }>}
 */
async function processStrategyBatch(plan, strategy, notify, gate) {
    const beforeIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    const outcome = await runLayer0(plan, notify, gate);
    const afterIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    return {
        success: outcome.status === 'completed',
        blocked: outcome.status === 'blocked',
        ...strategy.assessCommit(plan, beforeIndex, afterIndex),
    };
}

async function normalizeManualMemory(tally, notify, gate) {
    if (tally.aborted || tally.blocked || tally.completed === 0 || tally.failed > 0) {
        return 'skipped';
    }
    if ((await gate.promptWorkGate('manual promotion')) === 'blocked') {
        info('Manual promotion deferred; prompt mutation guard is active.');
        return 'blocked';
    }
    return (await normalizePromotions(notify, gate)).status;
}

async function normalizePromotions(notify, gate) {
    return await drainPromotionOverflow({ maxConsecutiveFailures: 3, notify, gate });
}

async function prepareManualRun(deps, recoverReason) {
    return (
        (await deps.gate.promptWorkGate(recoverReason, { refreshUi: deps.refreshUi })) === 'open'
    );
}

/** @param {Partial<ManualRunTally>} [overrides] @returns {ManualRunTally} */
function createManualRunTally(overrides = {}) {
    return {
        completed: 0,
        failed: 0,
        totalBatches: 0,
        aborted: false,
        blocked: false,
        failureLimitReached: false,
        ...overrides,
    };
}

/** @param {ManualRunTally} tally @returns {ManualRunProgress} */
function createProgress(tally) {
    return {
        completed: tally.completed,
        failed: tally.failed,
        totalBatches: tally.totalBatches,
    };
}

function isCancelled(signal) {
    return Boolean(signal?.aborted);
}

function logRoutePlan(routePlan, s) {
    const stats = routePlan.tokenStats;
    trace(
        `Mode: ${s.memoryMode}, recent: ${formatTokenValue(stats.verbatimTokens)}/` +
            `${formatTokenValue(stats.verbatimBudget)}, queued: ${formatTokenValue(stats.queuedTokens)}/` +
            `${formatTokenValue(stats.queuedBudget)}, partitions: ${stats.partitionCount}`,
    );
}
