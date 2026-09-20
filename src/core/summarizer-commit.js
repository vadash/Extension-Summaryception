import { debug, info, trace, warn } from '../foundation/logger.js';
import {
    getStreamingProcessor,
    isGeneratingFlagSet,
    isSendButtonInStopMode,
} from '../foundation/context.js';

/** @typedef {'applied' | 'queued' | 'stale'} CommitResult */
/** @typedef {'applied' | 'queued'} PromptEffectResult */

/**
 * @typedef {object} SummarizationJobSnapshot
 * @property {string} chatId - Best-effort stable chat identity.
 * @property {ChatMessage[]} chatRef - Chat array reference captured before the request.
 * @property {[number, number]} sourceRange - Transient source chat index range.
 * @property {string[]} sourceMessageIds - Stable IDs for the captured source messages.
 * @property {string} sourceFingerprint - Hash of the source range, rechecked before commit.
 * @property {number} summaryStoreEpoch - Summary-layer mutation epoch.
 * @property {string} passageText - Raw passage text captured for the job.
 * @property {import('./chatutils.js').PassageRegexStats} passageStats - Regex stats of the captured passage.
 * @property {string} contextText - Continuity context text captured for the job.
 */

/**
 * @typedef {object} PendingCommit
 * @property {string} kind - Human-readable commit type.
 * @property {SummarizationJobSnapshot | object} snapshot - Snapshot to revalidate.
 * @property {() => Promise<boolean>} apply - Applies the commit, returning false when stale.
 */

/**
 * @typedef {object} PromptEffectContext
 * @property {number} epoch - Generation epoch captured before the effect started.
 */

/**
 * @typedef {object} PendingPromptEffect
 * @property {string} kind - Human-readable effect type.
 * @property {(ctx: PromptEffectContext) => Promise<boolean> | boolean} apply - Runs the effect; false requeues it against the captured epoch.
 */
/** Silent default so pre-init gate calls stay no-ops. */
const noOpCallback = () => {};

let foregroundFrozen = false;
let pendingCommits = [];
let pendingPromptEffects = [];
/** @type {(options?: object) => void} */
let updateInjectionCallback = noOpCallback;
/** @type {() => void} */
let reassertInjectionCallback = noOpCallback;
/** @type {(reason: string) => void} */
let requeueCallback = noOpCallback;
let commitCallbacksInitialized = false;
let generationEpoch = 0;
let foregroundFreezeStartedAt = 0;
let staleRecoveryPromise = null;
const FOREGROUND_FREEZE_HEARTBEAT_GRACE_MS = 1000;

/**
 * Register the callbacks used by transaction commits. The composition root
 * initializes once; missing slots stay silent no-ops.
 * @param {object} callbacks
 * @param {(options?: object) => void} [callbacks.updateInjection]
 * @param {() => void} [callbacks.reassertInjection]
 * @param {(reason: string) => void} [callbacks.requeue]
 * @returns {void}
 */
export function initCommitCallbacks({ updateInjection, reassertInjection, requeue }) {
    if (commitCallbacksInitialized) {
        throw new Error(
            'initCommitCallbacks double init: wiring happens once at the composition root.',
        );
    }
    commitCallbacksInitialized = true;
    updateInjectionCallback = updateInjection || noOpCallback;
    reassertInjectionCallback = reassertInjection || noOpCallback;
    requeueCallback = requeue || noOpCallback;
}

/**
 * @returns {boolean}
 */
export function isPromptMutationFrozen() {
    recoverStalePromptFreezeInBackground('prompt mutation check');
    return foregroundFrozen || Boolean(staleRecoveryPromise);
}

/**
 * The stale-freeze heal is deliberately absent here: the heal's own flush
 * must apply queued prompt effects and commits, and every effect queued by
 * that flush would otherwise requeue against the heal's in-flight promise
 * forever (an endless microtask loop that freezes the page). A generation
 * starting mid-flush bumps the epoch and sets the freeze, so the epoch check
 * alone gates the race.
 * @param {number} epoch
 * @returns {boolean}
 */
export function canStartPromptMutation(epoch) {
    recoverStalePromptFreezeInBackground('prompt mutation start');
    return !foregroundFrozen && epoch === generationEpoch;
}

/**
 * Freeze prompt-affecting mutations after the beforeFreeze hook runs and the
 * committed injection is reasserted. The hook is the one gate-sanctioned
 * window for pre-freeze prompt writes (ADR-0016): it runs while the gate is
 * still open, before the freeze locks slot content.
 * @param {{ beforeFreeze?: () => void }} [options]
 * @returns {void}
 */
export function beginForegroundGeneration({ beforeFreeze } = {}) {
    if (beforeFreeze) {
        beforeFreeze();
    }
    reassertCommittedInjectionIfOpen();
    foregroundFrozen = true;
    foregroundFreezeStartedAt = Date.now();
    generationEpoch++;
    info('Foreground freeze on.');
}

/**
 * @returns {Promise<void>}
 */
export async function endForegroundGeneration() {
    if (!foregroundFrozen && pendingCommits.length === 0 && pendingPromptEffects.length === 0) {
        return;
    }

    foregroundFrozen = false;
    foregroundFreezeStartedAt = 0;
    const commits = pendingCommits.length;
    const effects = pendingPromptEffects.length;
    info(`Foreground freeze off; commits=${commits}, effects=${effects} flushed.`);
    await flushPendingCommits();
    await flushPendingPromptEffects();
}

/**
 * Commit immediately when safe, otherwise queue until generation finishes.
 * @param {PendingCommit} commit
 * @returns {Promise<CommitResult>}
 */
export async function commitWhenSafe(commit) {
    if (foregroundFrozen) {
        await recoverStalePromptFreeze(`${commit.kind} commit`);
    }

    if (foregroundFrozen) {
        pendingCommits.push(commit);
        debug(`Queued ${commit.kind} commit while foreground generation is active.`);
        return 'queued';
    }

    return await applyCommit(commit);
}

/**
 * Update the committed injection snapshot after a metadata commit.
 * @returns {Promise<PromptEffectResult>}
 */
export async function updateCommittedInjection(options = {}) {
    return await runPromptEffect({
        kind: 'injection-update',
        apply: () => {
            if (updateInjectionCallback) {
                updateInjectionCallback(options);
            }
            return true;
        },
    });
}

/**
 * Queue a prompt-affecting effect until foreground generation finishes.
 * @param {PendingPromptEffect} effect
 * @returns {void}
 */
export function queuePromptEffect(effect) {
    pendingPromptEffects.push(effect);
    trace(`Queued ${effect.kind} prompt effect while foreground generation is active.`);
}

/**
 * Run a prompt effect when safe, otherwise queue it.
 * @param {PendingPromptEffect} effect
 * @returns {Promise<PromptEffectResult>}
 */
export async function runPromptEffect(effect) {
    if (foregroundFrozen) {
        await recoverStalePromptFreeze(`${effect.kind} effect`);
    }

    if (foregroundFrozen) {
        queuePromptEffect(effect);
        return 'queued';
    }

    const epoch = generationEpoch;
    if (!canStartPromptMutation(epoch)) {
        queuePromptEffect(effect);
        return 'queued';
    }

    const completed = await effect.apply({ epoch });
    return completed ? 'applied' : 'queued';
}

/**
 * Stop prompt-affecting work while foreground generation or queued effects need priority.
 * @returns {boolean}
 */
function shouldStopPromptWork() {
    return isPromptMutationFrozen() || pendingCommits.length > 0 || pendingPromptEffects.length > 0;
}

/**
 * Ask the foreground gate whether prompt-affecting work may start, first
 * attempting to recover a stale freeze so a heal reopens the gate inline.
 * @param {string} reason - Context for diagnostic logging
 * @param {{ refreshUi?: () => void }} [options]
 * @returns {Promise<'open'|'blocked'>}
 */
export async function promptWorkGate(reason, { refreshUi } = {}) {
    await recoverStalePromptFreeze(reason, { refreshUi });
    return shouldStopPromptWork() ? 'blocked' : 'open';
}

/**
 * Clear a stale foreground freeze when SillyTavern is no longer generating.
 * @param {string} reason - Context for debug logging
 * @param {{ refreshUi?: () => void }} [opts]
 * @returns {Promise<boolean>} True when stale guard state was cleared
 */
export async function recoverStalePromptFreeze(reason, { refreshUi } = {}) {
    if (staleRecoveryPromise) {
        await staleRecoveryPromise;
        if (refreshUi) {
            refreshUi();
        }
        return true;
    }

    if (!foregroundFrozen || !hasForegroundFreezeGraceElapsed() || isForegroundGenerationActive()) {
        return false;
    }

    warn('Stale foreground freeze detected; auto-healing lock', `reason=${reason}`);
    staleRecoveryPromise = endForegroundGeneration().finally(() => {
        staleRecoveryPromise = null;
    });
    await staleRecoveryPromise;
    if (refreshUi) {
        refreshUi();
    }
    return true;
}

/**
 * Reset transient foreground guard state without clearing registered callbacks.
 * @returns {void}
 */
export function resetPromptMutationGuard() {
    foregroundFrozen = false;
    pendingCommits = [];
    pendingPromptEffects = [];
    generationEpoch = 0;
    foregroundFreezeStartedAt = 0;
    staleRecoveryPromise = null;
}

/**
 * @returns {void}
 */
export function resetCommitStateForTests() {
    resetPromptMutationGuard();
    updateInjectionCallback = noOpCallback;
    reassertInjectionCallback = noOpCallback;
    requeueCallback = noOpCallback;
    commitCallbacksInitialized = false;
}

/**
 * Best-effort check for an active SillyTavern foreground generation.
 * @returns {boolean}
 */
function isForegroundGenerationActive() {
    try {
        const streamingProcessor = getStreamingProcessor();
        if (streamingProcessor?.isFinished === false) {
            return true;
        }
        // ST keeps body[data-generating] set until activateSendButtons clears
        // it — after hideStopButton has already emitted GENERATION_ENDED. The
        // stop-button probe alone reads "idle" during that teardown window
        // and false-heals the freeze the end handler is releasing.
        if (isGeneratingFlagSet()) {
            return true;
        }
        return isSendButtonInStopMode();
    } catch (_e) {
        return false;
    }
}

/**
 * Avoid healing during the brief gap between SillyTavern's start event and live indicators.
 * @returns {boolean}
 */
function hasForegroundFreezeGraceElapsed() {
    return (
        foregroundFreezeStartedAt === 0 ||
        Date.now() - foregroundFreezeStartedAt >= FOREGROUND_FREEZE_HEARTBEAT_GRACE_MS
    );
}

/**
 * Clear stale freeze state from synchronous guard checks.
 * @param {string} reason - Context for diagnostic logging
 * @returns {void}
 */
function recoverStalePromptFreezeInBackground(reason) {
    if (!foregroundFrozen || staleRecoveryPromise) {
        return;
    }

    void recoverStalePromptFreeze(reason).catch((error) => {
        warn('Error while recovering foreground generation freeze:', error);
    });
}

/**
 * @returns {void}
 */
function reassertCommittedInjectionIfOpen() {
    if (foregroundFrozen || staleRecoveryPromise) {
        return;
    }
    if (reassertInjectionCallback) {
        reassertInjectionCallback();
    }
}

/**
 * Apply a pending commit and request a fresh worker pass if it went stale.
 * @param {PendingCommit} commit
 * @returns {Promise<CommitResult>}
 */
async function applyCommit(commit) {
    const applied = await commit.apply();
    if (applied) {
        return 'applied';
    }

    debug(`Discarded stale ${commit.kind} result; requeueing summarization.`);
    if (requeueCallback) {
        requeueCallback(`stale-${commit.kind}`);
    }
    return 'stale';
}

/**
 * @returns {Promise<void>}
 */
async function flushPendingCommits() {
    while (!foregroundFrozen && pendingCommits.length > 0) {
        const commit = pendingCommits.shift();
        if (commit) {
            await applyCommit(commit);
        }
    }
}

/**
 * @returns {Promise<void>}
 */
async function flushPendingPromptEffects() {
    while (!foregroundFrozen && pendingPromptEffects.length > 0) {
        const effect = pendingPromptEffects.shift();
        if (effect) {
            await runPromptEffect(effect);
        }
    }
}
