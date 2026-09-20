import { MEMORY_MODES, TOAST_TITLE } from '../foundation/constants.js';
import { error } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/state.js';
import {
    describeManualRun,
    ELASTIC_STRATEGIES,
    pauseAutoSummarization,
    resumeAutoSummarization,
    runManual,
} from '../core/summarizer-engine.js';
import { isBusy, stopSummarization } from '../core/summarizer-queue.js';
import { refreshPreview } from '../foundation/refresh.js';
import { updateUI } from './ui.js';
import {
    clearManualProgressToast,
    confirmSlopBreaker,
    createManualProgressToast,
    showBusySummaryToast,
    showCatchupOutcome,
    showSlopBreakerNoop,
    showSlopBreakerOutcome,
    updateManualProgressToast,
} from './ui-dialogs.js';

/** @type {import('../core/summarizer-engine.js').ManualRunnerDeps} */
let manualRunnerDeps;
/** @type {import('../core/summarizer-engine.js').PauseLatchDeps} */
let pauseLatchDeps;

/**
 * Abort a manual summarization run from its progress toast.
 * @param {AbortController} controller
 * @returns {void}
 */
function cancelManualRun(controller) {
    controller.abort();
    stopSummarization();
}

const MANUAL_RUN_BUSY_HTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Working...</span>';

/**
 * Shared manual-run driver: busy button, abort/progress wiring, outcome
 * report, injection refresh, reload, and UI update. `run` receives the
 * engine options carrying the abort signal; returning undefined skips the
 * outcome report (nothing ran).
 * @param {object | null} $button jQuery-wrapped trigger button, disabled while running.
 * @param {string} idleHtml Button html restored after the run.
 * @param {{ run: (options: object) => Promise<object | undefined>, report: (outcome: object) => void, notify: import('../core/notify.js').NotifyAdapter }} ops
 * @returns {Promise<void>}
 */
async function runManualSummarization($button, idleHtml, { run, report, notify }) {
    const controller = new AbortController();
    let progressToast = null;
    const options = {
        signal: controller.signal,
        notify,
        onStart: (progress) => {
            progressToast = createManualProgressToast({
                ...progress,
                onCancel: () => cancelManualRun(controller),
            });
        },
        onProgress: (progress) => updateManualProgressToast(progressToast, progress),
    };
    if ($button) {
        $button.prop('disabled', true).html(MANUAL_RUN_BUSY_HTML);
    }
    let outcome;
    try {
        outcome = await run(options);
    } catch (err) {
        error(err);
        toastr.error('Summarization failed - check console.', TOAST_TITLE, {
            timeOut: 8000,
        });
        return;
    } finally {
        clearManualProgressToast(progressToast);
        if ($button) {
            $button.prop('disabled', false).html(idleHtml);
        }
        updateUI();
    }
    if (outcome !== undefined) {
        report(outcome);
        refreshPreview();
        reloadAfterManualRun(outcome);
    }
}

/**
 * Shared manual-run guard. Show the toast for the first failing check.
 * @param {object} s Effective settings.
 * @returns {boolean} true when a manual run is allowed.
 */
function guardManualRun(s) {
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return false;
    }
    if (isBusy()) {
        showBusySummaryToast();
        return false;
    }
    showManualCacheWarning(s);
    return true;
}

/**
 * Run Force Summarize from a panel button or the stale-cache advice toast.
 * @param {object | null} $button jQuery-wrapped trigger button, disabled while running.
 * @param {import('../core/notify.js').NotifyAdapter} notify Toastr-backed adapter distributed to core calls.
 * @returns {Promise<void>}
 */
async function executeForceSummarize($button, notify) {
    const s = getEffectiveSettings();
    if (!guardManualRun(s)) {
        return;
    }
    await runManualSummarization(
        $button,
        '<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>',
        {
            run: async (options) => {
                const preview = await describeManualRun(ELASTIC_STRATEGIES.FORCE);
                if (!preview.ready) {
                    toastr.info('Nothing eligible to summarize.', TOAST_TITLE);
                    return;
                }
                toastr.info(`${preview.backlog} turns ready to process. Starting...`, TOAST_TITLE, {
                    timeOut: 2000,
                });

                return runManual(manualRunnerDeps, ELASTIC_STRATEGIES.FORCE, options);
            },
            report: showCatchupOutcome,
            notify,
        },
    );
}

/**
 * Run Slop Breaker after validating the current chat tail.
 * @param {object} buttonEl Clicked DOM element (`this` in the jQuery handler).
 * @param {import('../core/notify.js').NotifyAdapter} notify Toastr-backed adapter distributed to core calls.
 * @returns {Promise<void>}
 */
async function onSlopBreaker(buttonEl, notify) {
    const s = getEffectiveSettings();
    if (!guardManualRun(s)) {
        return;
    }

    const preview = await describeManualRun(ELASTIC_STRATEGIES.SLOP);
    if (!preview.ready) {
        showSlopBreakerNoop();
        return;
    }
    if (!(await confirmSlopBreaker())) {
        return;
    }

    await runManualSummarization(
        $(buttonEl),
        '<i class="fa-solid fa-broom"></i><span>Slop Breaker</span>',
        {
            run: (options) => runManual(manualRunnerDeps, ELASTIC_STRATEGIES.SLOP, options),
            report: showSlopBreakerOutcome,
            notify,
        },
    );
}

function showManualCacheWarning(settings) {
    if (settings.memoryMode !== MEMORY_MODES.PREFIX_CACHE) {
        return;
    }
    toastr.info(
        'Manual summarization updates memory immediately and may reset cache savings for the next request.',
        TOAST_TITLE,
        { timeOut: 5000 },
    );
}

/**
 * Reload the page after successful manual context changes.
 * @param {{ fullyCommitted?: boolean } | undefined} outcome
 * @returns {void}
 */
function reloadAfterManualRun(outcome) {
    if (outcome?.fullyCommitted) {
        reloadPage();
    }
}

/**
 * Reload the SillyTavern page after context-changing actions.
 * @returns {void}
 */
export function reloadPage() {
    const reload = globalThis.location?.reload;
    if (typeof reload === 'function') {
        reload.call(globalThis.location);
    }
}

/**
 * Stop the in-flight summarizer and latch autoPaused so automatic cycles do
 * not resume on their own while the user is still changing settings.
 * @returns {Promise<void>}
 */
async function onStopSummarize() {
    const status = await pauseAutoSummarization(pauseLatchDeps);
    if (status === 'already-paused') {
        toastr.info('Already paused.', TOAST_TITLE);
        return;
    }
    if (status === 'idle') {
        toastr.info('Nothing is running.', TOAST_TITLE);
        return;
    }
    toastr.warning('Summarization paused. Progress saved. Press Resume to continue.', TOAST_TITLE, {
        timeOut: 5000,
    });
    $(this).prop('disabled', true);
    setTimeout(() => $(this).prop('disabled', false), 2000);
    updateUI();
}

/**
 * Clear the autoPaused latch and kick a single automatic cycle.
 * @returns {Promise<void>}
 */
async function onResumeSummarize() {
    const status = await resumeAutoSummarization(pauseLatchDeps);
    if (status === 'not-paused') {
        toastr.info('Not paused.', TOAST_TITLE);
        return;
    }
    toastr.success('Resumed. Automatic summarization is active again.', TOAST_TITLE, {
        timeOut: 3000,
    });
    updateUI();
}

/**
 * Bind the manual-run controls: Force Summarize, Slop Breaker, the
 * stale-cache advice toast action that starts the same manual run, and the
 * Stop/Resume controls.
 * @param {{ notify: import('../core/notify.js').NotifyAdapter, manualRunnerDeps: import('../core/summarizer-engine.js').ManualRunnerDeps, pauseLatchDeps: import('../core/summarizer-engine.js').PauseLatchDeps }} deps
 * @returns {void}
 */
export function bindManualRunControls({
    notify,
    manualRunnerDeps: runnerDeps,
    pauseLatchDeps: latchDeps,
}) {
    manualRunnerDeps = runnerDeps;
    pauseLatchDeps = latchDeps;
    $(document).on('click', '#sc_force_summarize, #sc_easy_force_summarize', async function () {
        await executeForceSummarize($(this), notify);
    });
    $(document).on('click', '#sc_slop_breaker, #sc_easy_slop_breaker', function () {
        return onSlopBreaker(this, notify);
    });
    $(document).on('click', '#sc_stale_cache_force', function () {
        const $toast = $(this).closest('.toast');
        if ($toast.length) {
            toastr.clear($toast);
        }
        void executeForceSummarize(null, notify);
    });
    $(document).on('click', '#sc_stop_summarize, #sc_easy_stop_summarize', onStopSummarize);
    $(document).on('click', '#sc_resume_summarize, #sc_easy_resume_summarize', onResumeSummarize);
}
