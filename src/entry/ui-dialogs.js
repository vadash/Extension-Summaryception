import { TOAST_TITLE } from '../foundation/constants.js';

/**
 * Show the Slop Breaker no-op toast.
 * @returns {void}
 */
export function showSlopBreakerNoop() {
    toastr.info('Nothing to reset yet. Wait for an AI reply first.', TOAST_TITLE);
}
/**
 * Show the warning shown when a summarization run is already in progress.
 * @returns {void}
 */
export function showBusySummaryToast() {
    toastr.warning('Already summarizing. Please wait.', TOAST_TITLE);
}

/**
 * Show the warning shown when foreground generation blocks a manual run.
 * @returns {void}
 */
export function showForegroundActiveToast() {
    toastr.warning('Foreground generation is active. Try again once it completes.', TOAST_TITLE);
}

/**
 * Show the appropriate toast after a catch-up run finishes.
 * @param {import('../core/summarizer-engine.js').ManualRunOutcome} outcome
 * @returns {void}
 */
export function showCatchupOutcome(outcome) {
    if (outcome.blocked && outcome.totalBatches === 0) {
        showForegroundActiveToast();
    } else if (outcome.cancelled) {
        toastr.warning(
            `Catch-up paused at ${outcome.completed}/${outcome.totalBatches}. Progress saved - will continue on next message.`,
            TOAST_TITLE,
            { timeOut: 5000 },
        );
    } else if (outcome.blocked) {
        toastr.warning(
            `Catch-up paused at ${outcome.completed}/${outcome.totalBatches}. Try again after generation finishes.`,
            TOAST_TITLE,
            { timeOut: 5000 },
        );
    } else if (outcome.failureLimitReached) {
        toastr.error(
            '3 consecutive failures - API may be down. Pausing catch-up. Progress saved; will resume on next message.',
            TOAST_TITLE,
            { timeOut: 8000 },
        );
    } else if (outcome.totalBatches > 0 && outcome.failed === 0) {
        toastr.success(`Catch-up complete! ${outcome.completed} batches processed.`, TOAST_TITLE, {
            timeOut: 4000,
        });
    } else if (outcome.failed > 0) {
        toastr.warning(
            `Catch-up finished. ${outcome.completed} succeeded, ${outcome.failed} failed (will retry on next trigger).`,
            TOAST_TITLE,
            { timeOut: 6000 },
        );
    }
}

/**
 * Show the Slop Breaker completion, abort, or failure toast.
 * @param {import('../core/summarizer-engine.js').ManualRunOutcome} outcome
 * @returns {void}
 */
export function showSlopBreakerOutcome(outcome) {
    if (outcome.fullyCommitted) {
        toastr.success('Slop Breaker complete. Reloading chat context.', TOAST_TITLE, {
            timeOut: 3000,
        });
    } else if (outcome.blocked && outcome.totalBatches === 0) {
        showForegroundActiveToast();
    } else if (outcome.totalBatches === 0) {
        showSlopBreakerNoop();
    } else if (outcome.cancelled && outcome.completed === 0) {
        toastr.warning('Slop Breaker stopped. No new cut was completed.', TOAST_TITLE, {
            timeOut: 5000,
        });
    } else if (outcome.cancelled || outcome.blocked) {
        toastr.warning(
            'Slop Breaker stopped. Partial progress was saved, but the intended cut was not completed.',
            TOAST_TITLE,
            { timeOut: 6000 },
        );
    } else if (outcome.completed === 0) {
        toastr.error('Slop Breaker failed. No new cut was completed.', TOAST_TITLE, {
            timeOut: 6000,
        });
    } else {
        toastr.warning(
            `Slop Breaker paused after ${outcome.completed} batch${outcome.completed === 1 ? '' : 'es'}. ` +
                `${outcome.failed} failed; the intended cut was not completed.`,
            TOAST_TITLE,
            { timeOut: 6000 },
        );
    }
}

/**
 * Create a persistent manual run progress toast.
 * @param {import('../core/summarizer-engine.js').ManualRunProgress & { onCancel: () => void }} progress
 * @returns {unknown}
 */
export function createManualProgressToast(progress) {
    return toastr.info(getProgressText(progress), progress.title, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        onCloseClick: progress.onCancel,
    });
}

/**
 * Update an existing manual run progress toast.
 * @param {unknown} progressToast
 * @param {import('../core/summarizer-engine.js').ManualRunProgress} progress
 * @returns {void}
 */
export function updateManualProgressToast(progressToast, progress) {
    $(progressToast)
        .find('.toast-message')
        .text(`${getProgressText(progress)}\nClick x to pause`);
}

/**
 * Clear a manual run progress toast if it exists.
 * @param {unknown} progressToast
 * @returns {void}
 */
export function clearManualProgressToast(progressToast) {
    if (progressToast) {
        toastr.clear(progressToast);
    }
}

/**
 * Show the stale-cache advice toast with a Force Summarize action button.
 * Stays for a minute or until closed; the button click is handled by ui-events.
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
 * Show the Slop Breaker confirmation modal.
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
 * Build manual run progress text.
 * @param {import('../core/summarizer-engine.js').ManualRunProgress} progress
 * @returns {string}
 */
function getProgressText(progress) {
    const pct = Math.round((progress.completed / progress.totalBatches) * 100);
    const failStr = progress.failed > 0 ? ` | ${progress.failed} failed` : '';
    return `${progress.label}: ${progress.completed} / ${progress.totalBatches} batches (${pct}%)${failStr}`;
}
