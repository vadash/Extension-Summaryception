import { MEMORY_MODES } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { log } from '../foundation/logger.js';
import { getCacheFriendlyPlan } from './cache-planner.js';
import { summarizeCacheFlush } from './summarizer-cache.js';
import { summarizeBatchFromTurns } from './summarizer-batch.js';
import { maybePromoteLayer } from './summarizer-promotion.js';
import { getLayer0OverflowPlan } from './verbatim-window.js';
import { recoverStalePromptFreeze, shouldStopPromptWork } from './summarizer-commit.js';

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

    if (s.memoryMode === MEMORY_MODES.CACHE) {
        return await runCacheFriendlyWorkerCycle(queue, s);
    }

    const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), s);
    logOverflowPlan(plan, s);

    if (plan.reason !== 'none') {
        queue.setPhase('layer0');
        return await processLayer0Overflow({ plan, s });
    }

    queue.setPhase('promoting');
    return await processPromotions(s);
}

/**
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
export async function yieldWorkerCycle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Process a single layer-0 overflow batch in automatic mode.
 * @param {object} p
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} p.plan
 * @param {object} p.s
 * @returns {Promise<'processed' | 'blocked' | 'failed'>}
 */
async function processLayer0Overflow({ plan, s }) {
    const backlogThreshold = s.maxSummaryTurns * 2;

    if (plan.eligibleTurns.length > backlogThreshold) {
        showAutoBacklogNotice(plan);
    }

    const turns = plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
    const success = await summarizeBatchFromTurns(turns, {
        showToasts: false,
        catchExceptions: true,
    });

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return 'failed';
    }
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    return 'processed';
}

/**
 * Process cache-friendly auto summarization.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {ExtensionSettings} s
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
async function runCacheFriendlyWorkerCycle(queue, s) {
    const plan = await getCacheFriendlyPlan(getChat(), getChatStore(), s);
    logCachePlan(plan);

    if (plan.reason !== 'ready') {
        return 'idle';
    }

    queue.setPhase('layer0');
    const result = await summarizeCacheFlush(plan);
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    if (result === 'failed' || result === 'stale') {
        return 'failed';
    }
    return 'processed';
}

/**
 * Process one promotion step when summary layers are over their limits.
 * @param {object} s
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
async function processPromotions(s) {
    const hadOverflow = hasPromotionOverflow(0, s);
    const promoted = await maybePromoteLayer(0);
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    if (promoted) {
        return 'processed';
    }
    return hadOverflow ? 'failed' : 'idle';
}

/**
 * Check whether any promotable layer currently exceeds its limit.
 * @param {number} startLayer
 * @param {object} s
 * @returns {boolean}
 */
function hasPromotionOverflow(startLayer, s) {
    const store = getChatStore();
    const layers = Array.isArray(store?.layers) ? store.layers : [];
    const maxLayer = Math.min(layers.length, s.maxLayers - 1);
    for (let i = startLayer; i < maxLayer; i++) {
        if ((layers[i]?.length || 0) > s.snippetsPerLayer) {
            return true;
        }
    }
    return false;
}

/**
 * Log dynamic verbatim-window planning details.
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} plan
 * @param {object} s
 * @returns {void}
 */
function logOverflowPlan(plan, s) {
    log(
        `Visible assistant turns: ${plan.visibleTurnCount}, max batch: ${s.maxSummaryTurns}, ` +
            `verbatim budget: ${plan.budgetStats.finalTokens}/${s.verbatimTokenBudget} tokens, ` +
            `summary budget: ${plan.summaryStats.finalTokens}/${s.minSummaryBudget} tokens`,
    );
}

/**
 * Log cache-friendly planning details.
 * @param {import('./cache-planner.js').CacheFriendlyPlan} plan
 * @returns {void}
 */
function logCachePlan(plan) {
    log(
        `Cache mode live tokens: ${plan.liveTokens}/${plan.cacheBudget}, ` +
            `protected tail: ${plan.protectedTailTokens}, ` +
            `flush: ${plan.estimatedFlushTokens}, chunks: ${plan.chunks.length}`,
    );
}

/**
 * Show a non-blocking notice for large automatic backlog catch-up.
 * @param {import('./verbatim-window.js').Layer0OverflowPlan} plan
 * @returns {void}
 */
function showAutoBacklogNotice(plan) {
    if (catchupDismissed) {
        return;
    }

    catchupDismissed = true;
    if (autoBacklogNotifier) {
        autoBacklogNotifier(plan);
    }
}
