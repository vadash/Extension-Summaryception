import { log, trace } from '../foundation/logger.js';

/** @typedef {'applied' | 'queued' | 'stale'} CommitResult */

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

let foregroundFrozen = false;
let pendingCommits = [];
let updateInjectionCallback = null;
let reassertInjectionCallback = null;
let requeueCallback = null;

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
 * Freeze prompt-affecting mutations and reassert the committed injection.
 * @returns {void}
 */
export function beginForegroundGeneration() {
    foregroundFrozen = true;
    reassertCommittedInjection();
    log('Foreground generation started; prompt-affecting mutations frozen.');
}

/**
 * Unfreeze prompt-affecting mutations and flush queued commits.
 * @returns {Promise<void>}
 */
export async function endForegroundGeneration() {
    if (!foregroundFrozen && pendingCommits.length === 0) {
        return;
    }

    foregroundFrozen = false;
    log('Foreground generation ended; flushing pending Summaryception commits.');
    await flushPendingCommits();
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
 * @returns {void}
 */
export function updateCommittedInjection() {
    if (foregroundFrozen) {
        reassertCommittedInjection();
        return;
    }
    if (updateInjectionCallback) {
        updateInjectionCallback();
    }
}

/**
 * Reassert the last committed injection without recomputing from in-flight work.
 * @returns {void}
 */
export function reassertCommittedInjection() {
    if (reassertInjectionCallback) {
        reassertInjectionCallback();
    }
}

/**
 * Get the number of commits waiting for the foreground guard to open.
 * @returns {number}
 */
export function getPendingCommitCount() {
    return pendingCommits.length;
}

/**
 * Reset transient guard state. Intended for tests.
 * @returns {void}
 */
export function resetCommitStateForTests() {
    foregroundFrozen = false;
    pendingCommits = [];
    updateInjectionCallback = null;
    reassertInjectionCallback = null;
    requeueCallback = null;
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
