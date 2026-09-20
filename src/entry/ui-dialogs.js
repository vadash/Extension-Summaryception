import { ELASTIC_STRATEGIES } from '../core/summarizer-engine.js';
import { formatTokenValue } from '../core/token-count.js';
import {
    BATCH_PROGRESS,
    GHOST_PROGRESS,
    NOTIFY_EVENTS,
    TOAST_TITLE,
} from '../foundation/constants.js';

const IDLE_MESSAGES = {
    [ELASTIC_STRATEGIES.FORCE]: 'Nothing eligible to summarize.',
    [ELASTIC_STRATEGIES.SLOP]: 'Nothing to reset yet. Wait for an AI reply first.',
};

/**
 * The one "nothing to run" renderer: a pre-check that found no work and a run
 * that reported `idle` both land here.
 * @param {string} strategy Manual run strategy.
 * @returns {void}
 */
export function showManualRunIdle(strategy) {
    toastr.info(IDLE_MESSAGES[strategy], TOAST_TITLE);
}
/**
 * @returns {void}
 */
export function showBusySummaryToast() {
    toastr.warning('Already summarizing. Please wait.', TOAST_TITLE);
}

/**
 * @returns {void}
 */
export function showForegroundActiveToast() {
    toastr.warning('Foreground generation is active. Try again once it completes.', TOAST_TITLE);
}

/**
 * Catch-up notices: the status picks the notice, the counts phrase it. A gate
 * block with no batch planned never started, which is its own notice.
 * @type {Record<string, ManualRunNotice>}
 */
const CATCHUP_NOTICES = {
    idle: () => showManualRunIdle(ELASTIC_STRATEGIES.FORCE),
    blocked: (outcome) => {
        if (outcome.totalBatches === 0) {
            showForegroundActiveToast();
            return;
        }
        toastr.warning(
            `Catch-up paused at ${outcome.completed}/${outcome.totalBatches}. Try again after generation finishes.`,
            TOAST_TITLE,
            { timeOut: 5000 },
        );
    },
    aborted: (outcome) =>
        toastr.warning(
            `Catch-up paused at ${outcome.completed}/${outcome.totalBatches}. Progress saved - will continue on next message.`,
            TOAST_TITLE,
            { timeOut: 5000 },
        ),
    failed: () =>
        toastr.error(
            '3 consecutive failures - API may be down. Pausing catch-up. Progress saved; will resume on next message.',
            TOAST_TITLE,
            { timeOut: 8000 },
        ),
    completed: (outcome) =>
        toastr.success(`Catch-up complete! ${outcome.completed} batches processed.`, TOAST_TITLE, {
            timeOut: 4000,
        }),
    partial: (outcome) =>
        toastr.warning(
            `Catch-up finished. ${outcome.completed} succeeded, ${outcome.failed} failed (will retry on next trigger).`,
            TOAST_TITLE,
            { timeOut: 6000 },
        ),
};

const SLOP_STOPPED_NOTICE =
    'Slop Breaker stopped. Partial progress was saved, but the intended cut was not completed.';

/**
 * A Slop Breaker that committed nothing reports failure; one that committed
 * part of the cut reports where it stopped.
 * @type {ManualRunNotice}
 */
function showSlopIncomplete(outcome) {
    if (outcome.completed === 0) {
        toastr.error('Slop Breaker failed. No new cut was completed.', TOAST_TITLE, {
            timeOut: 6000,
        });
        return;
    }
    toastr.warning(
        `Slop Breaker paused after ${outcome.completed} batch${outcome.completed === 1 ? '' : 'es'}. ` +
            `${outcome.failed} failed; the intended cut was not completed.`,
        TOAST_TITLE,
        { timeOut: 6000 },
    );
}

/**
 * Slop Breaker notices, selected by status and phrased from the counts it
 * committed.
 * @type {Record<string, ManualRunNotice>}
 */
const SLOP_NOTICES = {
    idle: () => showManualRunIdle(ELASTIC_STRATEGIES.SLOP),
    completed: () =>
        toastr.success('Slop Breaker complete. Reloading chat context.', TOAST_TITLE, {
            timeOut: 3000,
        }),
    blocked: (outcome) => {
        if (outcome.totalBatches === 0) {
            showForegroundActiveToast();
            return;
        }
        toastr.warning(SLOP_STOPPED_NOTICE, TOAST_TITLE, { timeOut: 6000 });
    },
    aborted: (outcome) => {
        if (outcome.completed === 0) {
            toastr.warning('Slop Breaker stopped. No new cut was completed.', TOAST_TITLE, {
                timeOut: 5000,
            });
            return;
        }
        toastr.warning(SLOP_STOPPED_NOTICE, TOAST_TITLE, { timeOut: 6000 });
    },
    failed: showSlopIncomplete,
    partial: showSlopIncomplete,
};

/**
 * @typedef {(outcome: import('../core/run-outcome.js').ManualRunOutcome) => void} ManualRunNotice
 */

/**
 * Display policy for one manual run strategy: the progress text core reports
 * counts for, and the notice each terminal status renders (ADR-0004).
 * @typedef {object} ManualRunView
 * @property {string} label - Progress text label for the active operation.
 * @property {string} title - User-visible progress toast title.
 * @property {Record<string, ManualRunNotice>} notices - Notice per Run Outcome status; an unmapped status stays silent.
 */

/** @type {Record<string, ManualRunView>} */
const MANUAL_RUN_VIEWS = {
    [ELASTIC_STRATEGIES.FORCE]: {
        label: 'Processing',
        title: 'Summaryception Catch-Up',
        notices: CATCHUP_NOTICES,
    },
    [ELASTIC_STRATEGIES.SLOP]: {
        label: 'Breaking slop',
        title: 'Summaryception Slop Breaker',
        notices: SLOP_NOTICES,
    },
};

/**
 * @param {string} strategy Manual run strategy.
 * @returns {ManualRunView}
 */
export function manualRunView(strategy) {
    return MANUAL_RUN_VIEWS[strategy];
}

/**
 * @param {import('../core/summarizer-engine.js').ManualRunProgress} progress
 * @param {ManualRunView} view - Display policy of the running strategy.
 * @param {() => void} onCancel - Cancels the run from the toast's close button.
 * @returns {unknown}
 */
export function createManualProgressToast(progress, view, onCancel) {
    return toastr.info(getProgressText(progress, view.label), view.title, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        onCloseClick: onCancel,
    });
}

/**
 * @param {unknown} progressToast
 * @param {import('../core/summarizer-engine.js').ManualRunProgress} progress
 * @param {ManualRunView} view - Display policy of the running strategy.
 * @returns {void}
 */
export function updateManualProgressToast(progressToast, progress, view) {
    $(progressToast)
        .find('.toast-message')
        .text(`${getProgressText(progress, view.label)}\nClick x to pause`);
}

/**
 * @param {unknown} progressToast
 * @returns {void}
 */
export function clearManualProgressToast(progressToast) {
    if (progressToast) {
        toastr.clear(progressToast);
    }
}

/**
 * The delegated click handler in ui-manual-run.js handles the Force
 * Summarize button.
 * @param {import('../core/cache-staleness.js').StaleCacheAdvice} advice
 * @returns {unknown}
 */
export function showStaleCacheAdvice(advice) {
    return toastr.info(
        `The provider cache is stale: the last turn is ${advice.staleMinutes} minutes old and your cache TTL is ${advice.ttlMinutes} minutes. ` +
            `About ${advice.queuedTurns} turns wait in the summarize queue. ` +
            'Summarize now and your next message pays full input price once, on a smaller prompt. Send a message first, and you pay full price twice.' +
            '<br><button id="sc_stale_cache_force" class="menu_button" style="margin-top: 8px;">' +
            '<i class="fa-solid fa-bolt"></i> Force Summarize now</button>',
        'Summaryception — Stale Cache',
        {
            timeOut: 60000,
            extendedTimeOut: 60000,
            closeButton: true,
            tapToDismiss: false,
            escapeHtml: false,
        },
    );
}

/**
 * @returns {Promise<boolean>}
 */
export function confirmSlopBreaker() {
    return new Promise((resolve) => {
        const $overlay = $('<div class="sc-catchup-overlay">')
            .html(
                `
        <div class="sc-catchup-modal">
        <h3>Run Slop Breaker?</h3>
        <div class="sc-catchup-dialog">
        <p>This summarizes the current live conversation context, including messages normally kept verbatim. Use it when the AI is stuck repeating phrases, formats, or corrections. If the latest message is an AI reply, it will be committed into memory and may no longer be safe to swipe or regenerate.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_slop_breaker_confirm" class="menu_button">
        <i class="fa-solid fa-broom"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Break Slop</span>
        </div>
        </button>
        <button id="sc_slop_breaker_cancel" class="menu_button">
        <i class="fa-solid fa-xmark"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Cancel</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `,
            )
            .appendTo('body');

        $overlay.find('#sc_slop_breaker_confirm').on('click', () => {
            $overlay.remove();
            resolve(true);
        });
        $overlay.find('#sc_slop_breaker_cancel').on('click', () => {
            $overlay.remove();
            resolve(false);
        });
    });
}

/**
 * Counted views render `text: done / total` lines; message views render one
 * static string and ignore counts.
 * @typedef {object} ProgressView
 * @property {string} [subtitle] - Title suffix after the toast title; omitted renders the bare title.
 * @property {boolean} [tracksForegroundPause] - Track the open toast so a foreground generation can reword it while summarization waits.
 * @property {string} [text] - Action text leading each counted progress line.
 * @property {string} [message] - Static toast message; replaces counted lines.
 * @property {boolean} [progressBar] - Show toastr's progress bar.
 * @property {number} [everyN] - Render only when processed is a multiple of this (counted views only).
 */

/**
 * Display policy lives in the UI; core reports counts only.
 * @type {Record<string, ProgressView>}
 */
const NOTIFY_PROGRESS_VIEWS = {
    [GHOST_PROGRESS.HIDE]: { subtitle: 'Ghosting', text: 'Hiding messages', everyN: 1 },
    [GHOST_PROGRESS.UNHIDE]: { subtitle: 'Clearing', text: 'Unhiding messages', everyN: 10 },
    [BATCH_PROGRESS.MEMORY]: {
        message: 'Updating conversation memory…',
        progressBar: true,
        tracksForegroundPause: true,
    },
};

/**
 * @type {ProgressView}
 */
const DEFAULT_PROGRESS_VIEW = { subtitle: 'Working', text: 'Working', everyN: 1 };

/**
 * Terminal notices render right after the progress toast closes (ADR-0004).
 * Unknown kinds close silently.
 * @type {Record<string, () => void>}
 */
const NOTIFY_TERMINAL_VIEWS = {
    [BATCH_PROGRESS.UPDATED]: () =>
        toastr.success('Conversation memory updated.', TOAST_TITLE, { timeOut: 3000 }),
    [BATCH_PROGRESS.ABORTED]: () =>
        toastr.warning('Conversation memory update stopped.', TOAST_TITLE, { timeOut: 3000 }),
    [BATCH_PROGRESS.FAILED]: () =>
        toastr.warning('Conversation memory was not updated.', TOAST_TITLE, { timeOut: 3000 }),
    [GHOST_PROGRESS.UNHIDDEN]: () =>
        toastr.success('Chat restored.', TOAST_TITLE, { timeOut: 3000 }),
};

/**
 * Fixed display duration for retry warnings. Independent of the backoff wait,
 * which lives in retry policy (ADR-0004).
 */
const RETRY_NOTICE_MS = 5000;

/**
 * Per-kind transient notice policy (ADR-0004): severity, fixed display
 * duration, and phrasing built from the event's structured payload. Durations
 * never derive from core wait times; unknown kinds stay silent.
 * @type {Record<string, (event: import('../core/notify.js').NotifyTransientEvent) => void>}
 */
const NOTIFY_TRANSIENT_VIEWS = {
    [NOTIFY_EVENTS.RUN_ABORTED]: () =>
        toastr.warning('Summarization stopped.', TOAST_TITLE, { timeOut: 3000 }),
    [NOTIFY_EVENTS.RUN_FAILED]: (event) =>
        toastr.error(
            `Summarization failed` +
                `${event.retriesExhausted ? ` after ${event.attempts} attempts` : ''}` +
                `${event.status ? ` (${event.status})` : ''}. Batch skipped; will retry on next trigger.`,
            TOAST_TITLE,
            { timeOut: 8000 },
        ),
    [NOTIFY_EVENTS.EASY_GUARD_BLOCKED]: (event) =>
        toastr.error(
            `Easy mode blocked ${event.label}: summarizer request is ` +
                `${formatTokenValue(event.tokens, event.estimated)} tokens, above the ` +
                `${formatTokenValue(event.limit)} Easy Summarizer Context cap. ` +
                'Raise the Easy context slider or switch to Advanced.',
            TOAST_TITLE,
            { timeOut: 10000 },
        ),
    [NOTIFY_EVENTS.RETRY_WAIT]: (event) =>
        toastr.warning(
            `Summarizer request failed. Retrying (attempt ${(event.attempt ?? 0) + 1} of ${event.maxRetries ?? 0})...`,
            TOAST_TITLE,
            { timeOut: RETRY_NOTICE_MS },
        ),
    [NOTIFY_EVENTS.ROUTE_CYCLE_WAIT]: () =>
        toastr.warning('Both summarizer routes failed. Retrying primary...', TOAST_TITLE, {
            timeOut: RETRY_NOTICE_MS,
        }),
    [NOTIFY_EVENTS.LANGUAGE_MIX_RETRY]: (event) =>
        toastr.warning(
            `Summarizer response contained too much CN text (${event.percent ?? '?'}%). Retrying...`,
            TOAST_TITLE,
            { timeOut: RETRY_NOTICE_MS },
        ),
    [NOTIFY_EVENTS.PROMOTION_STARTED]: (event) =>
        toastr.info(
            `Promoting ${event.mergedCount} memories: Layer ${event.fromLayer} -> ` +
                `Layer ${event.toLayer}`,
            TOAST_TITLE,
            { timeOut: 3000, progressBar: true },
        ),
};

/**
 * @typedef {object} ToastrProgressHandle
 * @property {object} toast - Active toastr element.
 * @property {ProgressView} view - Matched display policy for the label.
 * @property {number} total - Total items reported by the progress event.
 */

/** Open "Updating conversation memory" toast element, kept for the pause reword. */
let activeMemoryToast = null;

const MEMORY_PAUSED_MESSAGE = 'Paused while you chat; memory updates after your reply.';

/**
 * @returns {void}
 */
export function pauseMemoryToastForGeneration() {
    if (!activeMemoryToast) {
        return;
    }
    $(activeMemoryToast).find('.toast-message').text(MEMORY_PAUSED_MESSAGE);
}

/**
 * Display durations and update cadence live here. Events carry structured
 * data only (ADR-0004).
 * @returns {import('../core/notify.js').NotifyAdapter}
 */
export function createToastrNotifyAdapter() {
    return {
        transient(event) {
            const kind = /** @type {string} */ (event?.kind);
            const view = NOTIFY_TRANSIENT_VIEWS[kind];
            if (view) {
                view(/** @type {import('../core/notify.js').NotifyTransientEvent} */ (event));
            }
        },
        progress(event) {
            const view = NOTIFY_PROGRESS_VIEWS[event.label] || DEFAULT_PROGRESS_VIEW;
            const toast = toastr.info(
                view.message ?? `${view.text}: 0 / ${event.total}`,
                view.subtitle ? `${TOAST_TITLE} - ${view.subtitle}` : TOAST_TITLE,
                {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    tapToDismiss: false,
                    ...(view.progressBar ? { progressBar: true } : {}),
                },
            );
            if (view.tracksForegroundPause) {
                activeMemoryToast = toast;
            }
            return { toast, view, total: event.total };
        },
        update(handle, event) {
            if (!handle) {
                return;
            }
            const progress = /** @type {ToastrProgressHandle} */ (handle);
            if (!progress.view.everyN || event.processed % progress.view.everyN !== 0) {
                return;
            }
            const pct = Math.round((event.processed / progress.total) * 100);
            $(progress.toast)
                .find('.toast-message')
                .text(`${progress.view.text}: ${event.processed} / ${progress.total} (${pct}%)`);
        },
        clear(handle, event) {
            if (handle) {
                toastr.clear(/** @type {ToastrProgressHandle} */ (handle).toast);
            }
            if (
                activeMemoryToast &&
                /** @type {ToastrProgressHandle} */ (handle)?.toast === activeMemoryToast
            ) {
                activeMemoryToast = null;
            }
            const terminal = event?.kind
                ? NOTIFY_TERMINAL_VIEWS[/** @type {string} */ (event.kind)]
                : null;
            if (terminal) {
                terminal();
            }
        },
    };
}

/**
 * @param {import('../core/summarizer-engine.js').ManualRunProgress} progress
 * @param {string} label - Progress text label for the active operation.
 * @returns {string}
 */
function getProgressText(progress, label) {
    const pct = Math.round((progress.completed / progress.totalBatches) * 100);
    const failStr = progress.failed > 0 ? ` | ${progress.failed} failed` : '';
    return `${label}: ${progress.completed} / ${progress.totalBatches} batches (${pct}%)${failStr}`;
}
