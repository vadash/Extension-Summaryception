import { LOG_PREFIX } from './constants.js';
import { sendSummarizerRequest } from './connectionutil.js';
import { getSettings, getChatStore, saveChatStore, getPlayerName } from './state.js';
import { log, trace } from './logger.js';
import { RETRY_CONFIG, parseRetryAfter, isRetryableError } from './retry.js';
import { ghostMessage, ghostMessagesUpTo } from './ghosting.js';
import { getAssistantTurns, buildPassageFromRange, buildFullContext } from './chatutils.js';
import {
    snapshotPromptToggles,
    disableAllPromptToggles,
    restorePromptToggles,
    cleanSummarizerOutput,
} from './prompts.js';
import { persistChatState } from './persist.js';

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

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;

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
 * Check whether an abort controller is active.
 * @returns {boolean}
 */
export function hasActiveAbortController() {
    return Boolean(currentAbortController);
}

/**
 * Abort the in-flight summarization request.
 * @returns {void}
 */
export function abortSummarization() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

/**
 * Build a promise that rejects on abort or after a timeout, whichever comes first.
 * @param {AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<never>}
 */
function makeTimeoutRace(signal, timeoutMs) {
    return new Promise((_, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Request timed out after 120s')),
            timeoutMs,
        );
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted by user'));
        });
    });
}

/**
 * Wait for a delay, resolving early if the signal is aborted.
 * @param {number} delay - Milliseconds to wait
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function sleepUntilOrAborted(delay, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Compute the retry delay for a given attempt, honoring Retry-After headers.
 * @param {Error} err - The error from the failed attempt
 * @param {number} attempt - Zero-based attempt index
 * @returns {number} Delay in milliseconds
 */
function computeRetryDelay(err, attempt) {
    const retryAfterMs = parseRetryAfter(err);
    if (retryAfterMs) {
        return Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
    }
    const exponentialDelay =
        RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
    return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
}

/**
 * Run a single summarizer attempt and classify the outcome.
 * @param {object} p
 * @param {object} p.s - Settings
 * @param {string} p.prompt - The fully substituted prompt
 * @param {AbortSignal} p.signal
 * @param {number} p.attempt - Zero-based attempt index
 * @returns {Promise<{ success: boolean, result: string, error: Error, aborted: boolean, shouldRetry: boolean }>}
 */
async function executeSummarizerAttempt({ s, prompt, signal, attempt }) {
    trace(`  Attempt ${attempt} starting...`);

    try {
        if (attempt > 0) {
            log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
        }

        trace('  About to call sendSummarizerRequest with:', {
            connectionSource: s.connectionSource,
            summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
            promptLength: prompt.length,
        });

        const result = await Promise.race([
            sendSummarizerRequest(s, s.summarizerSystemPrompt, prompt),
            makeTimeoutRace(signal, 120000),
        ]);

        trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

        let trimmed = (result || '').trim();
        trimmed = cleanSummarizerOutput(trimmed);

        if (!trimmed) {
            log('Empty response from LLM, treating as retryable');
            return {
                success: false,
                result: '',
                error: new Error('Empty response from summarizer'),
                aborted: false,
                shouldRetry: true,
            };
        }

        log('Result:', trimmed);
        trace('<<< EXITING callSummarizer WITH SUCCESS');
        return {
            success: true,
            result: trimmed,
            error: new Error('no error'),
            aborted: false,
            shouldRetry: false,
        };
    } catch (err) {
        const error =
            /** @type {Error & { retryable?: boolean, message?: string, status?: number, response?: { status?: number } }} */ (
                err
            );
        trace(`  Caught error on attempt ${attempt}:`, {
            name: error?.name,
            message: error?.message,
            retryable: error?.retryable,
        });

        if (signal.aborted || error.message === 'Aborted by user') {
            return { success: false, result: '', error, aborted: true, shouldRetry: false };
        }

        if (!isRetryableError(error)) {
            console.error(LOG_PREFIX, 'Non-retryable error:', error);
        }

        return {
            success: false,
            result: '',
            error,
            aborted: false,
            shouldRetry: isRetryableError(error),
        };
    }
}

/**
 * Call the configured summarizer backend with retry logic.
 * @param {string} storyTxt - The story text to summarize
 * @param {string} contextStr - The accumulated context string
 * @returns {Promise<string>} The generated summary, or '' on failure/abort
 */
export async function callSummarizer(storyTxt, contextStr) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const prompt = s.summarizerUserPrompt
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) {
        disableAllPromptToggles();
    }

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    /** @type {Error & { status?: number, response?: { status?: number } }} */
    let lastError = new Error('no error');

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            if (signal.aborted) {
                return abortWithToast();
            }

            const attemptResult = await executeSummarizerAttempt({ s, prompt, signal, attempt });

            if (attemptResult.success) {
                return attemptResult.result;
            }

            lastError = attemptResult.error;

            if (attemptResult.aborted) {
                return abortWithToast();
            }

            if (!attemptResult.shouldRetry) {
                trace('  ERROR IS NON-RETRYABLE, BREAKING');
                break;
            }

            if (attempt >= RETRY_CONFIG.maxRetries) {
                trace('  MAX RETRIES EXHAUSTED');
                console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                break;
            }

            await notifyRetryAndWait(lastError, attempt, signal);
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: 8000 },
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';
    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

/**
 * Log + toast an abort and return the sentinel '' value.
 * @returns {string} Always ''
 */
function abortWithToast() {
    log('Summarization aborted by user.');
    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
    return '';
}

/**
 * Notify the user about a retry attempt and wait the computed delay.
 * @param {Error} lastError - The error that triggered the retry
 * @param {number} attempt - Zero-based attempt index
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function notifyRetryAndWait(
    /** @type {Error & { status?: number, response?: { status?: number } }} */ lastError,
    attempt,
    signal,
) {
    const delay = computeRetryDelay(lastError, attempt);
    const delaySec = (delay / 1000).toFixed(1);
    const status = lastError?.status || lastError?.response?.status || '?';

    console.warn(
        LOG_PREFIX,
        `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`,
        lastError.message || lastError,
    );

    toastr.warning(
        `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
        'Summaryception',
        { timeOut: delay },
    );

    await sleepUntilOrAborted(delay, signal);
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

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
    } // ← new
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

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter((t) => !chat[t.index].extra?.sc_ghosted);
    if (
        remaining.length > s.verbatimTurns &&
        remaining.length - s.verbatimTurns <= backlogThreshold
    ) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Batch Summarization (shared) ─────────────────────────────

/**
 * Shared batch summarization logic used by both normal and catch-up paths.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @param {{ showToasts?: boolean, catchExceptions?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function summarizeBatchFromTurns(
    /** @type {Array<Record<string, unknown>>} */ visibleTurns,
    /** @type {{ showToasts?: boolean, catchExceptions?: boolean }} */
    { showToasts = false, catchExceptions = false } = {},
) {
    trace('>>> ENTERING summarizeBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Filter out turns that are at or before summarizedUpTo.
    // This handles desync where summarizedUpTo advanced but ghosting failed
    // (e.g., connection drop mid-summarization). Without this filter, the batch
    // always starts at the first un-ghosted turn, gets rejected, and loops forever.
    const eligibleTurns = visibleTurns.filter(
        (t) => /** @type {number} */ (t.index) > store.summarizedUpTo,
    );
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(
            (t) => /** @type {number} */ (t.index) <= store.summarizedUpTo,
        );
        for (const t of turnsToGhost) {
            await ghostMessage(/** @type {number} */ (t.index));
        }
        await persistChatState();
        trace('<<< EXITING summarizeBatchFromTurns - REPAIRED GHOSTING');
        return false;
    }

    return await summarizeBatchCore({
        s,
        chat,
        store,
        eligibleTurns,
        opts: { showToasts, catchExceptions },
    });
}

/**
 * Core logic for summarizing a batch of turns, separated to reduce complexity.
 * @param {object} s - Settings
 * @param {Array} chat - The chat array
 * @param {object} store - The chat store
 * @param {Array<Record<string, unknown>>} eligibleTurns - Turns eligible for summarization
 * @param {boolean} showToasts - Whether to show progress toasts
 * @param {boolean} catchExceptions - Whether to catch and swallow exceptions
 * @returns {Promise<boolean>}
 */
/**
 * Record a successful summary into Layer 0 and trigger downstream bookkeeping.
 * @param {object} p
 * @param {object} p.store - The chat store
 * @param {string} p.summary - The LLM-generated summary text
 * @param {number} p.passageStart - First chat index covered
 * @param {number} p.endIdx - Last chat index covered
 * @param {boolean} p.showToasts - Whether to show success toast
 * @returns {Promise<void>}
 */
async function commitLayer0Snippet({ store, summary, passageStart, endIdx, showToasts }) {
    store.layers[0].push({
        text: summary,
        turnRange: [passageStart, endIdx],
        timestamp: Date.now(),
    });

    store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
    trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

    // Save before ghosting so summarizedUpTo persists even if ghosting is interrupted
    await saveChatStore();
    await ghostMessagesUpTo(endIdx);
    await maybePromoteLayer(0);
    await persistChatState();

    log(`Layer 0 now has ${store.layers[0].length} snippets`);

    if (showToasts) {
        toastr.success(
            `Summary saved (Layer 0: ${store.layers[0].length} snippets)`,
            'Summaryception',
            { timeOut: 2000 },
        );
    }
}

async function summarizeBatchCore({ s, chat, store, eligibleTurns, opts }) {
    const batch = eligibleTurns.slice(0, Math.min(s.turnsPerSummary, eligibleTurns.length));

    if (batch.length === 0) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const startIdx = /** @type {number} */ (batch[0].index);
    const endIdx = /** @type {number} */ (batch[batch.length - 1].index);
    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

    if (!store.layers[0]) {
        store.layers[0] = [];
    }
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    if (passageStart > endIdx) {
        log(
            `ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`,
        );
        trace('<<< EXITING summarizeBatchFromTurns - PASSAGE START GREATER THAN END');
        return false;
    }

    try {
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeBatchFromTurns - EMPTY PASSAGE');
            return false;
        }

        const contextStr = buildFullContext(0);
        trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

        if (opts.showToasts) {
            toastr.info(
                `Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`,
                'Summaryception',
                {
                    timeOut: 3000,
                    progressBar: true,
                },
            );
        }

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeBatchFromTurns - EMPTY SUMMARY');
            return false;
        }

        await commitLayer0Snippet({
            store,
            summary,
            passageStart,
            endIdx,
            showToasts: opts.showToasts,
        });

        trace('<<< EXITING summarizeBatchFromTurns - SUCCESS');
        return true;
    } catch (err) {
        if (!opts.catchExceptions) {
            throw err;
        }
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Single Batch (Normal Mode) ────────────────────────────────

/**
 * Summarize a single batch of turns (normal mode, with toasts).
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

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

/**
 * Summarize one batch from pre-computed turns with exception catching.
 * @param {Array<Record<string, unknown>>} visibleTurns
 * @returns {Promise<boolean>}
 */
export async function summarizeOneBatchFromTurns(visibleTurns) {
    return await summarizeBatchFromTurns(visibleTurns, { catchExceptions: true });
}

// ─── Core: Catchup Processing ────────────────────────────────────────

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

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast)
                .find('.toast-message')
                .text(
                    `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`,
                );

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

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

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

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

/**
 * Promote a layer's snippets to the next layer if over the limit.
 * @param {number} layerIndex - The layer to evaluate
 * @returns {Promise<void>}
 */
export async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) {
        return;
    }

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) {
        store.layers[layerIndex + 1] = [];
    }
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        if (seed) {
            seed.promoted = true;
            seed.seedFromLayer = layerIndex;
            destLayer.push(seed);
        }

        log(
            `Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`,
        );

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: 2000 },
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map((sn) => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}
