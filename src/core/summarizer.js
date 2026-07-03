import { getChatStore, getSettings } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { getAssistantTurns } from './chatutils.js';
import { summarizeBatchFromTurns, summarizeOneBatchFromTurns } from './summarizer-batch.js';
import { abortCurrentSummarizerRequest } from './summarizer-request.js';
import { maybePromoteLayer } from './summarizer-promotion.js';
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

/**
 * @typedef {object} WorkerStatus
 * @property {boolean} running - A worker drain is active.
 * @property {boolean} pending - At least one summarization request is waiting.
 * @property {boolean} dirty - Chat changed while the worker was active.
 * @property {SummarizationMode} mode - Current worker mode.
 * @property {string} reason - Last request reason.
 */

/** @type {WorkerStatus} */
const workerStatus = {
    running: false,
    pending: false,
    dirty: false,
    mode: 'auto',
    reason: '',
};

let workerPromise = null;
let manualSummarizing = false;
let catchupDismissed = false;

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
    return workerStatus.running || manualSummarizing;
}

/**
 * Set the summarizing flag.
 * @param {boolean} value
 * @returns {void}
 */
export function setSummarizing(value) {
    manualSummarizing = value;
}

/**
 * Abort the in-flight summarization request.
 * @returns {void}
 */
export function abortSummarization() {
    abortCurrentSummarizerRequest();
    workerStatus.pending = false;
    workerStatus.dirty = false;
    manualSummarizing = false;
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
export function requestSummarization({ reason = 'auto', mode = 'auto' } = {}) {
    workerStatus.pending = true;
    workerStatus.reason = reason;
    workerStatus.mode = mode;

    if (workerStatus.running) {
        workerStatus.dirty = true;
        return workerPromise || Promise.resolve();
    }

    workerPromise = drainSummarizationWorker().finally(() => {
        workerPromise = null;
    });
    return workerPromise;
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
    manualSummarizing = true;
    try {
        return await summarizeBatchFromTurns(visibleTurns, { showToasts: true });
    } finally {
        manualSummarizing = false;
    }
}

/**
 * Drain coalesced auto work until the backlog is stable or guarded.
 * @returns {Promise<void>}
 */
async function drainSummarizationWorker() {
    workerStatus.running = true;
    refreshUI();

    try {
        do {
            workerStatus.pending = false;
            workerStatus.dirty = false;
            await drainAutoWork();
        } while (workerStatus.pending || workerStatus.dirty);
    } finally {
        workerStatus.running = false;
        refreshUI();
    }
}

/**
 * Drain ready automatic work against fresh chat state.
 * @returns {Promise<void>}
 */
async function drainAutoWork() {
    while (true) {
        const result = await runAutoWorkerCycle();
        if (result !== 'processed') {
            return;
        }
        await yieldWorkerCycle();
    }
}

/**
 * Run one automatic worker action against fresh chat state.
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
async function runAutoWorkerCycle() {
    await recoverStalePromptFreeze('auto worker');

    if (shouldStopAutoWorker()) {
        return 'blocked';
    }

    const s = getSettings();
    if (!s.enabled || s.pauseSummarization) {
        return 'idle';
    }

    const { chat } = SillyTavern.getContext();
    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter((t) => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length > s.verbatimTurns) {
        return await processLayer0Overflow({ visibleTurns, s });
    }

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
 * @param {Array<Record<string, unknown>>} p.visibleTurns
 * @param {object} p.s
 * @returns {Promise<'processed' | 'blocked' | 'failed'>}
 */
async function processLayer0Overflow({ visibleTurns, s }) {
    const overflow = visibleTurns.length - s.verbatimTurns;
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold) {
        showAutoBacklogNotice(overflow);
    }

    const success = await summarizeBatchFromTurns(visibleTurns, {
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
 * @param {number} overflow
 * @returns {void}
 */
function showAutoBacklogNotice(overflow) {
    if (catchupDismissed) {
        return;
    }

    catchupDismissed = true;
    toastr.info(
        `${overflow} turns exceed the verbatim limit. Summaryception will keep processing background batches while the chat is idle; use Force Summarize for a cancelable catch-up.`,
        'Summaryception',
        { timeOut: 6000 },
    );
}

/**
 *
 */
export async function runCatchup(visibleTurns, overflow) {
    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    if (!(await prepareCatchupRun())) {
        return;
    }

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
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

    manualSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const currentVisible = getCatchupVisibleTurns(s);
            if (!currentVisible) {
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const success = await summarizeOneBatchFromTurns(currentVisible);

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
        if (!cancelled) {
            await maybePromoteLayer(0);
        }
        showCatchupOutcome({ cancelled, completed, failed, totalBatches });
        refreshUI();
    } finally {
        manualSummarizing = false;
    }
}

/**
 * Get the latest visible assistant turns for catch-up, or null when complete.
 * @param {object} s - Settings
 * @returns {Array<Record<string, unknown>> | null}
 */
function getCatchupVisibleTurns(s) {
    const { chat } = SillyTavern.getContext();
    const allAssistantTurns = getAssistantTurns(chat);
    const currentVisible = allAssistantTurns.filter((t) => !chat[t.index].extra?.sc_ghosted);

    trace(
        `  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`,
    );

    if (currentVisible.length <= s.verbatimTurns) {
        trace('  Visible turns now within limit, breaking');
        return null;
    }

    return currentVisible;
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
 * @param {number} overflowCount - Number of unsummarized turns beyond the verbatim limit
 * @param {number} estimatedCalls - Estimated number of summarizer calls required
 * @returns {Promise<string>} 'catchup' | 'skip' | 'partial'
 */
export async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
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
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);
        const fullBtn = /** @type {HTMLElement} */ (overlay.querySelector('#sc_catchup_full'));
        const skipBtn = /** @type {HTMLElement} */ (overlay.querySelector('#sc_catchup_skip'));
        const partialBtn = /** @type {HTMLElement} */ (
            overlay.querySelector('#sc_catchup_partial')
        );
        fullBtn.addEventListener('click', () => {
            overlay.remove();
            resolve(/** @type {string} */ ('catchup'));
        });
        skipBtn.addEventListener('click', () => {
            overlay.remove();
            resolve(/** @type {string} */ ('skip'));
        });
        partialBtn.addEventListener('click', () => {
            overlay.remove();
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
    const ctx = /** @type {{ streamingProcessor?: { isFinished?: boolean } }} */ (
        SillyTavern.getContext()
    );
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
