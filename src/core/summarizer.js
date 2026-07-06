import { summarizeBatchFromTurns } from './summarizer-batch.js';
import { abortCurrentSummarizerRequest } from './summarizer-request.js';
import { SummarizerQueue } from './summarizer-queue.js';
import { withUsageRun } from './summarizer-usage.js';
import { flushPendingChatSave } from './persist-state.js';
import {
    resetCatchupDismissed as resetAutoCatchupDismissed,
    runAutoWorkerCycle,
    setAutoWorkerNotifiers,
    yieldWorkerCycle,
} from './summarizer-auto.js';
import {
    beginForegroundGeneration as beginCommitFreeze,
    endForegroundGeneration as endCommitFreeze,
    isPromptMutationFrozen,
    setCommitCallbacks,
} from './summarizer-commit.js';
import {
    runCatchup as runManualCatchup,
    runSlopBreaker as runManualSlopBreaker,
} from './summarizer-manual.js';

export { callSummarizer, hasActiveAbortController } from './summarizer-request.js';
export { summarizeOneBatchFromTurns } from './summarizer-batch.js';
export { maybePromoteLayer } from './summarizer-promotion.js';

/** @typedef {'auto'} SummarizationMode */
/** @typedef {import('./summarizer-manual.js').ManualRunOptions} ManualRunOptions */
/** @typedef {import('./summarizer-manual.js').ManualRunOutcome} ManualRunOutcome */

let uiUpdater = null;

const summarizerQueue = new SummarizerQueue({
    drainOneCycle: (queue) => runAutoWorkerCycle(queue, { refreshUi: refreshUI }),
    abort: abortCurrentSummarizerRequest,
    refreshUi: refreshUI,
    withUsageRun,
    yieldCycle: yieldWorkerCycle,
    afterDrain: flushPendingChatSave,
});

setCommitCallbacks({
    requeue: (reason) => {
        void requestSummarization({ reason, mode: 'auto' });
    },
});

/**
 * Check whether Summaryception is currently deferring prompt mutations.
 * @returns {boolean}
 */
export function hasFrozenPromptMutations() {
    return isPromptMutationFrozen();
}

/**
 * Register the settings UI refresh callback.
 * @param {() => void} callback
 * @returns {void}
 */
export function setUiUpdater(callback) {
    uiUpdater = callback;
}

/**
 * Register UI callbacks used by summarizer orchestration.
 * @param {{ showAutoBacklogNotice?: (plan: import('./verbatim-window.js').Layer0OverflowPlan) => void }} [notifiers]
 * @returns {void}
 */
export function setSummarizerNotifiers(notifiers = {}) {
    setAutoWorkerNotifiers(notifiers);
}

/**
 * Reset the catch-up dismissed flag so the dialog shows again.
 * @returns {void}
 */
export function resetCatchupDismissed() {
    resetAutoCatchupDismissed();
}

/**
 * Check whether a summarization cycle is currently running.
 * @returns {boolean}
 */
export function getIsSummarizing() {
    return summarizerQueue.getIsSummarizing();
}

/**
 * Set the manual summarizing flag.
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
    try {
        await endCommitFreeze();
        await flushPendingChatSave();
        await requestSummarization({ reason: 'generation-ended', mode: 'auto' });
    } finally {
        refreshUI();
    }
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
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatch(visibleTurns) {
    return await withUsageRun('manual batch', async () => {
        summarizerQueue.setSummarizing(true);
        try {
            return await summarizeBatchFromTurns(visibleTurns, { showToasts: true });
        } finally {
            summarizerQueue.setSummarizing(false);
            await flushPendingChatSave();
        }
    });
}

/**
 * Force the catch-up pass to summarize turns beyond the dynamic verbatim window.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {number} overflow
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runCatchup(visibleTurns, overflow, options = {}) {
    return await runManualCatchup(getManualRunnerDeps(), visibleTurns, overflow, options);
}

/**
 * Run Slop Breaker up to a fixed live-context cut.
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runSlopBreaker(options = {}) {
    return await runManualSlopBreaker(getManualRunnerDeps(), options);
}

/**
 * Refresh the settings UI if an updater is registered.
 * @returns {void}
 */
function refreshUI() {
    if (typeof uiUpdater === 'function') {
        uiUpdater();
    }
}

/**
 * Build dependencies for manual runner calls.
 * @returns {import('./summarizer-manual.js').ManualRunnerDeps}
 */
function getManualRunnerDeps() {
    return {
        queue: summarizerQueue,
        refreshUi: refreshUI,
        withUsageRun,
    };
}
