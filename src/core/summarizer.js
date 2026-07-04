import { getChat, getContext } from '../foundation/context.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { summarizeBatchFromTurns, summarizeOneBatchFromTurns } from './summarizer-batch.js';
import { abortCurrentSummarizerRequest } from './summarizer-request.js';
import { maybePromoteLayer } from './summarizer-promotion.js';
import { SummarizerQueue } from './summarizer-queue.js';
import { withUsageRun } from './summarizer-usage.js';
import { getLayer0OverflowPlan } from './verbatim-window.js';
import {
    beginForegroundGeneration as beginCommitFreeze,
    endForegroundGeneration as endCommitFreeze,
    getPendingCommitCount,
    getPendingPromptEffectCount,
    isPromptMutationFrozen,
    setCommitCallbacks,
} from './summarizer-commit.js';

export { callSummarizer, hasActiveAbortController } from './summarizer-request.js';
export { summarizeOneBatchFromTurns } from './summarizer-batch.js';
export { maybePromoteLayer } from './summarizer-promotion.js';

/**
 * Check whether Summaryception is currently deferring prompt mutations.
 * @returns {boolean}
 */
export function hasFrozenPromptMutations() {
    return isPromptMutationFrozen();
}

let uiUpdater = null;

/**
 *
 */
export function setUiUpdater(callback) {
    uiUpdater = callback;
}

function refreshUI() {
    if (typeof uiUpdater === 'function') {
        uiUpdater();
    }
}

/** @typedef {'auto'} SummarizationMode */
let catchupDismissed = false;

const summarizerQueue = new SummarizerQueue({
    drainOneCycle: runAutoWorkerCycle,
    abort: abortCurrentSummarizerRequest,
    refreshUi: refreshUI,
    withUsageRun,
    yieldCycle: yieldWorkerCycle,
});

setCommitCallbacks({
    requeue: (reason) => {
        void requestSummarization({ reason, mode: 'auto' });
    },
});

/**
 * Reset the catch-up dismissed flag so the dialog shows again.
 * @returns {void}
 */
export function resetCatchupDismissed() {
    catchupDismissed = false;
}

/**
 * Check whether a summarization cycle is currently running.
 * @returns {boolean}
 */
export function getIsSummarizing() {
    return summarizerQueue.getIsSummarizing();
}

/**
 * Set the summarizing flag.
 * @param {boolean} value
 * @returns {void}
 */
export function setSummarizing(value) {
    summarizerQueue.setSummarizing(value);
}

/**
 * Abort the in-flight summarization request.
 * @returns {void}
 */
export function abortSummarization() {
    summarizerQueue.abort();
}

/**
 * Register injection callbacks used by safe summary commits.
 * @param {() => void} updateInjection
 * @param {() => void} reassertInjection
 * @returns {void}
 */
export function setInjectionUpdater(updateInjection, reassertInjection) {
    setCommitCallbacks({
        updateInjection,
        reassertInjection,
        requeue: (reason) => {
            void requestSummarization({ reason, mode: 'auto' });
        },
    });
}

/**
 * Freeze summary commits while SillyTavern assembles a foreground prompt.
 * @returns {void}
 */
export function beginForegroundGeneration() {
    beginCommitFreeze();
    refreshUI();
}

/**
 * Flush deferred commits and resume work after foreground generation ends.
 * @returns {Promise<void>}
 */
export async function endForegroundGeneration() {
    await endCommitFreeze();
    await requestSummarization({ reason: 'generation-ended', mode: 'auto' });
    refreshUI();
}

/**
 * Queue or coalesce an automatic summarization request.
 * @param {{ reason?: string, mode?: SummarizationMode }} [opts]
 * @returns {Promise<void>}
 */
export function requestSummarization({ reason: _reason = 'auto', mode: _mode = 'auto' } = {}) {
    return summarizerQueue.request();
}

/**
 * Summarize the oldest verbatim turns if the overflow exceeds the limit.
 * @returns {Promise<void>}
 */
export async function maybeSummarizeTurns() {
    await requestSummarization({ reason: 'maybe-summarize', mode: 'auto' });
}

/**
 * Summarize a single batch of turns in normal mode, with toasts.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatch(visibleTurns) {
    return await withUsageRun('manual batch', async () => {
        summarizerQueue.setSummarizing(true);
        try {
            return await summarizeBatchFromTurns(visibleTurns, { showToasts: true });
        } finally {
            summarizerQueue.setSummarizing(false);
        }
    });
}

/**
 * Run one automatic worker action against fresh chat state.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
async function runAutoWorkerCycle(queue) {
    await recoverStalePromptFreeze('auto worker');

    if (shouldStopAutoWorker()) {
        queue.setPhase('paused');
        return 'blocked';
    }

    const s = getSettings();
    if (!s.enabled || s.pauseSummarization) {
        queue.setPhase('paused');
        return 'idle';
    }

    const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), s);

    log(
        `Visible assistant turns: ${plan.visibleTurnCount}, max batch: ${s.maxSummaryTurns}, ` +
            `verbatim budget: ${plan.budgetStats.finalTokens}/${s.verbatimTokenBudget} tokens, ` +
            `summary budget: ${plan.summaryStats.finalTokens}/${s.minSummaryBudget} tokens`,
    );

    if (plan.reason !== 'none') {
        queue.setPhase('layer0');
        return await processLayer0Overflow({ plan, s });
    }

    queue.setPhase('promoting');
    return await processPromotions(s);
}

/**
 * Stop when foreground generation or queued prompt effects need priority.
 * @returns {boolean}
 */
function shouldStopAutoWorker() {
    return (
        isPromptMutationFrozen() || getPendingCommitCount() > 0 || getPendingPromptEffectCount() > 0
    );
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
    if (shouldStopAutoWorker()) {
        return 'blocked';
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
    if (shouldStopAutoWorker()) {
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
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
async function yieldWorkerCycle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    toastr.info(
        `${plan.eligibleTurns.length} old turns are ready for summary. ` +
            'Summaryception will keep processing background batches while the chat is idle; ' +
            'use Force Summarize for a cancelable catch-up.',
        'Summaryception',
        { timeOut: 6000 },
    );
}

/**
 *
 */
export async function runCatchup(visibleTurns, overflow) {
    await withUsageRun('force summarize catch-up', async () => {
        trace('>>> ENTERING runCatchup');
        trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
        trace('  overflow:', overflow);

        if (!(await prepareCatchupRun())) {
            return;
        }

        const initialPlan = await getCatchupPlan();
        if (!initialPlan) {
            toastr.info(
                'Nothing to summarize - current chat is within the verbatim window.',
                'Summaryception',
            );
            return;
        }

        const totalBatches = estimateCatchupBatches(initialPlan);
        let completed = 0;
        let failed = 0;
        let cancelled = false;

        trace('  totalBatches calculated:', totalBatches);

        const progressToast = toastr.info(
            `Processing backlog: 0 / ${totalBatches} batches (0%)`,
            'Summaryception Catch-Up',
            {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                closeButton: true,
                onCloseClick: () => {
                    cancelled = true;
                    abortSummarization();
                },
            },
        );

        summarizerQueue.setSummarizing(true);

        try {
            let consecutiveFailures = 0;

            while (!cancelled) {
                trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

                const currentPlan = await getCatchupPlan();
                if (!currentPlan) {
                    break;
                }

                trace('  About to call summarizeOneBatchFromTurns...');
                const turns =
                    currentPlan.reason === 'repair'
                        ? currentPlan.visibleTurns
                        : currentPlan.batchTurns;
                const success = await summarizeOneBatchFromTurns(turns);

                if (success) {
                    trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                    completed++;
                    consecutiveFailures = 0;
                    if (shouldStopAutoWorker()) {
                        trace('  Prompt mutation queued; pausing catch-up until it flushes');
                        break;
                    }
                } else {
                    trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                    failed++;
                    consecutiveFailures++;

                    if (consecutiveFailures >= 3) {
                        toastr.error(
                            '3 consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.',
                            'Summaryception',
                            { timeOut: 8000 },
                        );
                        trace('  3 consecutive failures, breaking');
                        break;
                    }
                }

                updateProgressToast({ progressToast, completed, failed, totalBatches });

                await new Promise((r) => setTimeout(r, 200));
            }

            toastr.clear(progressToast);
            await maybePromoteAfterCatchup(cancelled);
            showCatchupOutcome({ cancelled, completed, failed, totalBatches });
            refreshUI();
        } finally {
            summarizerQueue.setSummarizing(false);
        }
    });
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
    if (shouldStopAutoWorker()) {
        log('Catch-up promotion deferred; prompt mutation guard is active.');
        return;
    }
    await maybePromoteLayer(0);
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
 * Update the catch-up progress toast text.
 * @param {object} p
 * @param {unknown} p.progressToast
 * @param {number} p.completed
 * @param {number} p.failed
 * @param {number} p.totalBatches
 * @returns {void}
 */
function updateProgressToast({ progressToast, completed, failed, totalBatches }) {
    const pct = Math.round((completed / totalBatches) * 100);
    const failStr = failed > 0 ? ` | ${failed} failed` : '';
    $(progressToast)
        .find('.toast-message')
        .text(
            `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`,
        );
}

/**
 * Show the appropriate toast after a catch-up run finishes.
 * @param {object} p
 * @param {boolean} p.cancelled
 * @param {number} p.completed
 * @param {number} p.failed
 * @param {number} p.totalBatches
 * @returns {void}
 */
function showCatchupOutcome({ cancelled, completed, failed, totalBatches }) {
    if (cancelled) {
        toastr.warning(
            `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
            'Summaryception',
            { timeOut: 5000 },
        );
    } else if (failed === 0) {
        toastr.success(`Catch-up complete! ${completed} batches processed.`, 'Summaryception', {
            timeOut: 4000,
        });
    } else {
        toastr.warning(
            `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
            'Summaryception',
            { timeOut: 6000 },
        );
    }
}

/**
 * Show the backlog catch-up dialog with process/skip/partial options.
 * @param {number} overflowCount - Number of unsummarized turns beyond the dynamic window
 * @param {number} estimatedCalls - Estimated number of summarizer calls required
 * @returns {Promise<string>} 'catchup' | 'skip' | 'partial'
 */
export async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();
        const partialBatchSize = s.maxSummaryTurns;

        const $overlay = $('<div class="sc-catchup-overlay">')
            .html(
                `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your dynamic verbatim window).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize up to ${partialBatchSize} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `,
            )
            .appendTo('body');

        const fullBtn = $overlay.find('#sc_catchup_full');
        const skipBtn = $overlay.find('#sc_catchup_skip');
        const partialBtn = $overlay.find('#sc_catchup_partial');

        fullBtn.on('click', () => {
            $overlay.remove();
            resolve(/** @type {string} */ ('catchup'));
        });
        skipBtn.on('click', () => {
            $overlay.remove();
            resolve(/** @type {string} */ ('skip'));
        });
        partialBtn.on('click', () => {
            $overlay.remove();
            resolve(/** @type {string} */ ('partial'));
        });
    });
}

/**
 * Clear a stale foreground freeze when SillyTavern is no longer generating.
 * @param {string} reason - Context for debug logging
 * @returns {Promise<boolean>} True when stale guard state was cleared
 */
async function recoverStalePromptFreeze(reason) {
    if (!isPromptMutationFrozen() || isForegroundGenerationActive()) {
        return false;
    }

    log(`Recovering stale foreground generation freeze before ${reason}.`);
    await endCommitFreeze();
    refreshUI();
    return true;
}

/**
 * Recover stale guard state and block catch-up during a real foreground generation.
 * @returns {Promise<boolean>} True when catch-up may proceed
 */
async function prepareCatchupRun() {
    await recoverStalePromptFreeze('manual catch-up');

    if (!shouldStopAutoWorker()) {
        return true;
    }

    toastr.warning(
        'Foreground generation is active. Try Force Summarize again after the response finishes.',
        'Summaryception',
        { timeOut: 5000 },
    );
    return false;
}

/**
 * Best-effort check for an active SillyTavern foreground generation.
 * @returns {boolean}
 */
function isForegroundGenerationActive() {
    const ctx = getContext();
    if (ctx.streamingProcessor && ctx.streamingProcessor.isFinished === false) {
        return true;
    }

    try {
        const stopButton = $('#mes_stop');
        return stopButton.length > 0 && stopButton.css('display') !== 'none';
    } catch (_e) {
        return false;
    }
}
