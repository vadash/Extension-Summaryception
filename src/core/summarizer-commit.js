import { log, trace } from '../foundation/logger.js';

/** @typedef {'applied' | 'queued' | 'stale'} CommitResult */
/** @typedef {'applied' | 'queued'} PromptEffectResult */

/**
 * @typedef {object} SummarizationJobSnapshot
 * @property {string} chatId - Best-effort stable chat identity.
 * @property {Array} chatRef - Chat array reference captured before the request.
 * @property {number} summarizedUpTo - Store cursor captured before the request.
 * @property {[number, number]} sourceRange - Source chat index range.
 * @property {string} sourceFingerprint - Fingerprint of source messages.
 * @property {string} summaryStoreFingerprint - Fingerprint of summary layers.
 * @property {string} passageText - Request passage text.
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

/**
 * Register callbacks used by transaction commits.
 * @param {object} callbacks
 * @param {() => void} [callbacks.updateInjection]
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
    return foregroundFrozen;
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
    return !foregroundFrozen && epoch === generationEpoch;
}

/**
 * Freeze prompt-affecting mutations after reasserting the committed injection.
 * @returns {void}
 */
export function beginForegroundGeneration() {
    reassertCommittedInjection();
    foregroundFrozen = true;
    generationEpoch++;
    log('Foreground generation started; prompt-affecting mutations frozen.');
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
    log('Foreground generation ended; flushing pending Summaryception commits.');
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
        pendingCommits.push(commit);
        trace(`Queued ${commit.kind} commit while foreground generation is active.`);
        return 'queued';
    }

    return await applyCommit(commit);
}

/**
 * Update the committed injection snapshot after a metadata commit.
 * @returns {Promise<PromptEffectResult>}
 */
export async function updateCommittedInjection() {
    return await runPromptEffect({
        kind: 'injection-update',
        apply: () => {
            if (updateInjectionCallback) {
                updateInjectionCallback();
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
    if (foregroundFrozen) {
        return;
    }
    if (reassertInjectionCallback) {
        reassertInjectionCallback();
    }
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
 * Reset transient guard state. Intended for tests.
 * @returns {void}
 */
export function resetCommitStateForTests() {
    foregroundFrozen = false;
    pendingCommits = [];
    pendingPromptEffects = [];
    updateInjectionCallback = null;
    reassertInjectionCallback = null;
    requeueCallback = null;
    generationEpoch = 0;
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

    log(`Discarded stale ${commit.kind} result; requeueing summarization.`);
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
