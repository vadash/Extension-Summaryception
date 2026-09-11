import { abortCurrentSummarizerRequest } from './summarizer-request.js';
import { SummarizerQueue } from './summarizer-queue.js';
import { withUsageRun } from './summarizer-usage.js';
import { flushPendingChatSave } from './persist-state.js';
import {
    runCatchup as runEngineCatchup,
    runElasticAutoCycle,
    runSlopBreaker as runEngineSlopBreaker,
    yieldWorkerCycle,
} from './summarizer-engine.js';
import {
    beginForegroundGeneration as beginCommitFreeze,
    endForegroundGeneration as endCommitFreeze,
    isPromptMutationFrozen,
    setCommitCallbacks,
} from './summarizer-commit.js';

export { callSummarizer, hasActiveAbortController } from './summarizer-request.js';
export { maybePromoteLayer } from './summarizer-promotion.js';
export { recoverStalePromptFreeze, resetPromptMutationGuard } from './summarizer-commit.js';

/** @typedef {import('./summarizer-engine.js').ManualRunOptions} ManualRunOptions */
/** @typedef {import('./summarizer-engine.js').ManualRunOutcome} ManualRunOutcome */

let uiUpdater = null;

const summarizerQueue = new SummarizerQueue({
    drainOneCycle: (queue) => runElasticAutoCycle(queue, { refreshUi: refreshUI }),
    abort: abortCurrentSummarizerRequest,
    refreshUi: refreshUI,
    withUsageRun,
    yieldCycle: yieldWorkerCycle,
    afterDrain: flushPendingChatSave,
});

setCommitCallbacks({
    requeue: () => {
        void requestSummarization();
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
        requeue: () => {
            void requestSummarization();
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
        await requestSummarization();
    } finally {
        refreshUI();
    }
}

/**
 * Queue or coalesce an automatic summarization request.
 * @returns {Promise<void>}
 */
export function requestSummarization() {
    return summarizerQueue.request();
}

/**
 * Force the catch-up pass to summarize turns beyond the dynamic verbatim window.
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runCatchup(options = {}) {
    return await runEngineCatchup(getManualRunnerDeps(), options);
}

/**
 * Run Slop Breaker up to a fixed live-context cut.
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runSlopBreaker(options = {}) {
    return await runEngineSlopBreaker(getManualRunnerDeps(), options);
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
 * @returns {import('./summarizer-engine.js').ManualRunnerDeps}
 */
function getManualRunnerDeps() {
    return {
        queue: summarizerQueue,
        refreshUi: refreshUI,
        withUsageRun,
    };
}
