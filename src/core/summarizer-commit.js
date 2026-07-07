import { debug, info, trace, warn } from '../foundation/logger.js';
import { getStreamingProcessor, isSendButtonInStopMode } from '../foundation/context.js';

/** @typedef {'applied' | 'queued' | 'stale'} CommitResult */
/** @typedef {'applied' | 'queued'} PromptEffectResult */

/**
 * @typedef {object} SummarizationJobSnapshot
 * @property {string} chatId - Best-effort stable chat identity.
 * @property {ChatMessage[]} chatRef - Chat array reference captured before the request.
 * @property {number} summarizedUpTo - Store cursor captured before the request.
 * @property {[number, number]} sourceRange - Source chat index range.
 * @property {string} sourceFingerprint - Fingerprint of source messages.
 * @property {number} summaryStoreEpoch - Summary-layer mutation epoch.
 * @property {string} passageText - Request passage text.
 * @property {import('./chatutils.js').PassageRegexStats} passageStats - Passage regex stats.
 * @property {string} contextText - Request context text.
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
 * @property {(ctx: PromptEffectContext) => Promise<boolean> | boolean} apply - Applies the effect.
 */

let foregroundFrozen = false;
let pendingCommits = [];
let pendingPromptEffects = [];
let updateInjectionCallback = null;
let reassertInjectionCallback = null;
let requeueCallback = null;
let generationEpoch = 0;
let foregroundFreezeStartedAt = 0;
let staleRecoveryPromise = null;

const FOREGROUND_FREEZE_HEARTBEAT_GRACE_MS = 1000;

/**
 * Register callbacks used by transaction commits.
 * @param {object} callbacks
 * @param {(options?: object) => void} [callbacks.updateInjection]
 * @param {() => void} [callbacks.reassertInjection]
 * @param {(reason: string) => void} [callbacks.requeue]
 * @returns {void}
 */
export function setCommitCallbacks({ updateInjection, reassertInjection, requeue } = {}) {
    if (updateInjection) {
        updateInjectionCallback = updateInjection;
    }
    if (reassertInjection) {
        reassertInjectionCallback = reassertInjection;
    }
    if (requeue) {
        requeueCallback = requeue;
    }
}

/**
 * Check whether prompt-affecting mutations are currently frozen.
 * @returns {boolean}
 */
export function isPromptMutationFrozen() {
    recoverStalePromptFreezeInBackground('prompt mutation check');
    return foregroundFrozen || Boolean(staleRecoveryPromise);
}

/**
 * Get the current foreground generation epoch.
 * @returns {number}
 */
export function getPromptMutationEpoch() {
    return generationEpoch;
}

/**
 * Check whether a prompt mutation may start for the captured epoch.
 * @param {number} epoch
 * @returns {boolean}
 */
export function canStartPromptMutation(epoch) {
    recoverStalePromptFreezeInBackground('prompt mutation start');
    return !foregroundFrozen && !staleRecoveryPromise && epoch === generationEpoch;
}

/**
 * Freeze prompt-affecting mutations after reasserting the committed injection.
 * @returns {void}
 */
export function beginForegroundGeneration() {
    reassertCommittedInjectionIfOpen();
    foregroundFrozen = true;
    foregroundFreezeStartedAt = Date.now();
    generationEpoch++;
    info('Foreground generation started; prompt-affecting mutations frozen.');
}

/**
 * Unfreeze prompt-affecting mutations and flush queued commits.
 * @returns {Promise<void>}
 */
export async function endForegroundGeneration() {
    if (!foregroundFrozen && pendingCommits.length === 0 && pendingPromptEffects.length === 0) {
        return;
    }

    foregroundFrozen = false;
    foregroundFreezeStartedAt = 0;
    info(
        'Foreground generation ended; flushing pending Summaryception commits.',
        `commits=${pendingCommits.length}`,
        `effects=${pendingPromptEffects.length}`,
    );
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
 * Reassert the last committed injection without recomputing from in-flight work.
 * @returns {void}
 */
export function reassertCommittedInjection() {
    if (isPromptMutationFrozen()) {
        return;
    }
    reassertCommittedInjectionIfOpen();
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
 * Get the number of commits waiting for the foreground guard to open.
 * @returns {number}
 */
export function getPendingCommitCount() {
    return pendingCommits.length;
}

/**
 * Get the number of prompt effects waiting for the foreground guard to open.
 * @returns {number}
 */
export function getPendingPromptEffectCount() {
    return pendingPromptEffects.length;
}

/**
 * Stop prompt-affecting work while foreground generation or queued effects need priority.
 * @returns {boolean}
 */
export function shouldStopPromptWork() {
    return isPromptMutationFrozen() || pendingCommits.length > 0 || pendingPromptEffects.length > 0;
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
 * Reset transient guard state. Intended for tests.
 * @returns {void}
 */
export function resetCommitStateForTests() {
    resetPromptMutationGuard();
    updateInjectionCallback = null;
    reassertInjectionCallback = null;
    requeueCallback = null;
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
 * Reassert the committed injection only when the guard is already open.
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
 * Flush all queued commits in FIFO order.
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
 * Flush all queued prompt effects in FIFO order.
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
