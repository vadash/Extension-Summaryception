import { getSettings, getChatStore, saveChatStore } from '../foundation/state.js';
import { log, trace } from '../foundation/logger.js';
import { getAssistantTurns } from './chatutils.js';
import { summarizeBatchFromTurns, summarizeOneBatchFromTurns } from './summarizer-batch.js';
import { abortCurrentSummarizerRequest } from './summarizer-request.js';

export { callSummarizer, hasActiveAbortController } from './summarizer-request.js';
export { summarizeOneBatchFromTurns } from './summarizer-batch.js';
export { maybePromoteLayer } from './summarizer-promotion.js';

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

let isSummarizing = false;
let catchupDismissed = false;

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
    return isSummarizing;
}

/**
 * Set the summarizing flag.
 * @param {boolean} value
 * @returns {void}
 */
export function setSummarizing(value) {
    isSummarizing = value;
}

/**
 * Abort the in-flight summarization request.
 * @returns {void}
 */
export function abortSummarization() {
    abortCurrentSummarizerRequest();
    isSummarizing = false;
}

/**
 * Summarize the oldest verbatim turns if the overflow exceeds the limit.
 * @returns {Promise<void>}
 */
export async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) {
        return;
    }
    if (s.pauseSummarization) {
        return;
    }
    if (isSummarizing) {
        return;
    }

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter((t) => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) {
        return;
    }

    const overflow = visibleTurns.length - s.verbatimTurns;
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        await handleBacklog({ visibleTurns, overflow, s, store });
        return;
    }

    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    await summarizeRemainingIfNeeded({ chat, s, backlogThreshold });
}

/**
 * Summarize a single batch of turns in normal mode, with toasts.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatch(visibleTurns) {
    isSummarizing = true;
    try {
        return await summarizeBatchFromTurns(visibleTurns, { showToasts: true });
    } finally {
        isSummarizing = false;
    }
}

/**
 * Process the large-backlog user choice.
 * @param {object} p
 * @param {Array<Record<string, unknown>>} p.visibleTurns
 * @param {number} p.overflow
 * @param {object} p.s
 * @param {object} p.store
 * @returns {Promise<void>}
 */
async function handleBacklog({ visibleTurns, overflow, s, store }) {
    log(`Large backlog detected: ${overflow} turns over limit`);

    const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
    const choice = await showCatchupDialog(overflow, batchesNeeded);

    if (choice === 'skip') {
        await skipBacklog({ visibleTurns, s, store });
    } else if (choice === 'catchup') {
        await runCatchup(visibleTurns, overflow);
    } else if (choice === 'partial') {
        await summarizeOneBatch(visibleTurns);
    }
}

/**
 * Mark the old backlog as summarized without generating summaries.
 * @param {object} p
 * @param {Array<Record<string, unknown>>} p.visibleTurns
 * @param {object} p.s
 * @param {object} p.store
 * @returns {Promise<void>}
 */
async function skipBacklog({ visibleTurns, s, store }) {
    const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
    if (cutoff) {
        store.summarizedUpTo = cutoff.index;
        log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
    }
    catchupDismissed = true;
    await saveChatStore();
}

/**
 * Continue normal summarization while a small overflow remains.
 * @param {object} p
 * @param {Array} p.chat
 * @param {object} p.s
 * @param {number} p.backlogThreshold
 * @returns {Promise<void>}
 */
async function summarizeRemainingIfNeeded({ chat, s, backlogThreshold }) {
    const remaining = getAssistantTurns(chat).filter((t) => !chat[t.index].extra?.sc_ghosted);
    if (
        remaining.length > s.verbatimTurns &&
        remaining.length - s.verbatimTurns <= backlogThreshold
    ) {
        await maybeSummarizeTurns();
    }
}

/**
 *
 */
export async function runCatchup(visibleTurns, overflow) {
    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

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

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(
                (t) => !chat[t.index].extra?.sc_ghosted,
            );

            trace(
                `  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`,
            );

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const success = await summarizeOneBatchFromTurns(currentVisible);

            if (success) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
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
        showCatchupOutcome({ cancelled, completed, failed, totalBatches });
        refreshUI();
    } finally {
        isSummarizing = false;
    }
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
