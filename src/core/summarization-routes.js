import { MEMORY_MODES } from '../foundation/constants.js';
import { buildChatWindowPlan } from './chat-window-planner.js';
import { getSlopBreakerPlan } from './slop-breaker.js';

export const SUMMARY_ROUTES = Object.freeze({
    STANDARD_AUTO: 'standard-auto',
    CACHE_AUTO: 'cache-auto',
    FORCE: 'force',
    SLOP: 'slop',
});

export const SUMMARY_COMMIT_MODES = Object.freeze({
    TURNS: 'turns',
    TURNS_WITH_SOURCE_END: 'turns-with-source-end',
    ATOMIC_PARTITIONS: 'atomic-partitions',
});

/**
 * @typedef {object} SummaryRouteTokenStats
 * @property {number} [verbatimTokens] Final token count of the verbatim tail.
 * @property {boolean} [verbatimEstimated] Whether the verbatim count is an estimate.
 * @property {number} [verbatimBudget] Configured verbatim token budget.
 * @property {number} [queuedTokens] Final token count of the queued window.
 * @property {boolean} [queuedEstimated] Whether the queued count is an estimate.
 * @property {number} [queuedBudget] Configured queued token budget.
 * @property {number} partitionCount Partitions covering the planned source span.
 */

/**
 * @typedef {object} SummaryRoutePlan
 * @property {string} route Selected route identifier from `SUMMARY_ROUTES`.
 * @property {boolean} ready True when the route can run a summarization batch now.
 * @property {string} reason Underlying chat window plan reason.
 * @property {string} commitMode Store commit strategy from `SUMMARY_COMMIT_MODES`.
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns Turns selected for the current batch.
 * @property {import('./partition-planner.js').SourcePartition[]} partitions Source partitions to commit.
 * @property {number} overflowCount Eligible turns awaiting summarization.
 * @property {number} totalBatches Batches the route runs, 0 when not ready.
 * @property {number} [sourceEndIdx] Optional exclusive end of the source window.
 * @property {number} [targetIndex] Numeric target boundary the run must reach.
 * @property {number} [visibleTurnCount] Assistant turns in the live chat window.
 * @property {SummaryRouteTokenStats} tokenStats Token counts and budgets backing the route.
 */

/**
 * Build the automatic route plan selected by the active memory mode.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildAutoSummaryRoutePlan(chat, store, settings) {
    const plan = await buildChatWindowPlan(chat, store, settings);
    const atomic = settings.memoryMode === MEMORY_MODES.PREFIX_CACHE;
    if (atomic) {
        return {
            route: SUMMARY_ROUTES.CACHE_AUTO,
            ready: plan.reason === 'ready',
            reason: plan.reason,
            commitMode: SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS,
            batchTurns: plan.batchTurns,
            partitions: plan.partitions,
            overflowCount: plan.overflowCount,
            totalBatches: plan.reason === 'ready' ? plan.partitions.length : 0,
            visibleTurnCount: plan.visibleTurnCount,
            tokenStats: buildWindowTokenStats(plan),
        };
    }
    return buildTurnRoute({
        route: SUMMARY_ROUTES.STANDARD_AUTO,
        ready: plan.reason !== 'none',
        plan,
        batchTurns: selectLayer0BatchTurns(plan),
        totalBatches: 1,
    });
}

/**
 * Flat auto-work read model for status rendering.
 * @typedef {object} AutoWorkReadModel
 * @property {boolean} ready Whether an automatic batch is ready now.
 * @property {number} backlog Eligible turns awaiting summarization.
 * @property {number} verbatimTokens Token count of the verbatim tail.
 * @property {boolean} verbatimEstimated Whether the verbatim count is an estimate.
 * @property {number} queuedTokens Token count of the queued window.
 * @property {boolean} queuedEstimated Whether the queued count is an estimate.
 */

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<AutoWorkReadModel>}
 */
export async function describeAutoWork(chat, store, settings) {
    const plan = await buildAutoSummaryRoutePlan(chat, store, settings);
    return {
        ready: plan.ready,
        backlog: Math.max(plan.batchTurns.length, plan.overflowCount),
        verbatimTokens: plan.tokenStats.verbatimTokens ?? 0,
        verbatimEstimated: plan.tokenStats.verbatimEstimated ?? false,
        queuedTokens: plan.tokenStats.queuedTokens ?? 0,
        queuedEstimated: plan.tokenStats.queuedEstimated ?? false,
    };
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildForceSummaryRoutePlan(chat, store, settings) {
    const plan = await buildChatWindowPlan(chat, store, settings, { ignoreReadiness: true });
    return buildTurnRoute({
        route: SUMMARY_ROUTES.FORCE,
        ready: plan.reason !== 'none',
        plan,
        batchTurns: selectLayer0BatchTurns(plan),
        totalBatches: plan.partitions.length,
        targetIndex: plan.queuedEndIdx,
    });
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @param {{ targetIndex?: number }} [opts]
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildSlopSummaryRoutePlan(chat, store, settings, opts = {}) {
    const plan = await getSlopBreakerPlan(chat, store, settings, opts);
    return {
        route: SUMMARY_ROUTES.SLOP,
        ready: plan.reason === 'ready',
        reason: plan.reason,
        commitMode: SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END,
        batchTurns: plan.batchTurns,
        partitions: plan.partitions,
        overflowCount: plan.eligibleTurns.length,
        totalBatches: plan.totalBatches,
        sourceEndIdx: plan.sourceEndIdx,
        targetIndex: plan.targetIndex,
        tokenStats: { partitionCount: plan.partitions.length },
    };
}

/**
 * @param {import('./chat-window-planner.js').ChatWindowPlan} plan
 * @returns {SummaryRouteTokenStats}
 */
function buildWindowTokenStats(plan) {
    return {
        verbatimTokens: plan.verbatimTokens,
        verbatimEstimated: plan.verbatimStats.finalTokensEstimated,
        verbatimBudget: plan.verbatimBudget,
        queuedTokens: plan.queuedTokens,
        queuedEstimated: plan.queuedStats.finalTokensEstimated,
        queuedBudget: plan.queuedBudget,
        partitionCount: plan.partitions.length,
    };
}

/**
 * Build the shared turn-route plan shape from a chat window plan.
 * @param {object} p
 * @param {string} p.route
 * @param {boolean} p.ready
 * @param {import('./chat-window-planner.js').ChatWindowPlan} p.plan
 * @param {import('./chatutils.js').AssistantTurn[]} p.batchTurns
 * @param {number} p.totalBatches
 * @param {number} [p.targetIndex]
 * @returns {SummaryRoutePlan}
 */
function buildTurnRoute({ route, ready, plan, batchTurns, totalBatches, targetIndex }) {
    return {
        route,
        ready,
        reason: plan.reason,
        commitMode: SUMMARY_COMMIT_MODES.TURNS,
        batchTurns,
        partitions: plan.partitions,
        overflowCount: plan.overflowCount,
        totalBatches: ready ? Math.max(1, totalBatches) : 0,
        visibleTurnCount: plan.visibleTurnCount,
        tokenStats: buildWindowTokenStats(plan),
        ...(typeof targetIndex === 'number' ? { targetIndex } : {}),
    };
}

function selectLayer0BatchTurns(plan) {
    return plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
}
