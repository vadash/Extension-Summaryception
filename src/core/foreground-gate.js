import {
    getStreamingProcessor,
    isGeneratingFlagSet,
    isSendButtonInStopMode,
} from '../foundation/context.js';
import { debug, info, trace, warn } from '../foundation/logger.js';

/** @typedef {'applied' | 'queued' | 'stale'} CommitResult */
/** @typedef {'applied' | 'queued'} PromptEffectResult */

/**
 * @typedef {object} PendingCommit
 * @property {string} kind - Human-readable commit type.
 * @property {() => Promise<boolean>} apply - Applies the commit, returning false when stale.
 */

/**
 * @typedef {object} PromptEffectContext
 * @property {number} epoch - Generation epoch captured before the effect started.
 * @property {() => boolean} canContinue - Whether the effect may keep mutating; false means a generation started mid-effect and the gate will re-run it.
 */

/**
 * @typedef {object} PendingPromptEffect
 * @property {string} kind - Human-readable effect type.
 * @property {(ctx: PromptEffectContext) => Promise<boolean> | boolean} apply - Runs the effect; false hands it back to the gate to re-run when the freeze lifts.
 */

/**
 * @typedef {object} ForegroundGateDeps
 * @property {() => void} reassertInjection - Re-asserts the committed injection before the freeze locks slot content.
 * @property {(reason: string) => void} requeue - Asks for a fresh summarization pass after a stale commit.
 * @property {() => number} [now] - Clock; injectable so the freeze grace window is testable.
 */

/**
 * Avoid healing during the brief gap between SillyTavern's start event and its live indicators.
 * @type {number}
 */
const FOREGROUND_FREEZE_HEARTBEAT_GRACE_MS = 1000;

/**
 * The one protocol every prompt mutation crosses (CONTEXT.md, Foreground Gate).
 * The gate owns the freeze boundary and decides whether prompt-affecting work
 * runs now, queues until the freeze lifts, or re-runs when it lifts — an effect
 * that reports it could not finish is the gate's to re-run, never the caller's.
 */
export class ForegroundGate {
    /** @type {() => void} */
    #reassertInjection;
    /** @type {(reason: string) => void} */
    #requeue;
    /** @type {() => number} */
    #now;

    #foregroundFrozen = false;
    /** @type {PendingCommit[]} */
    #pendingCommits = [];
    /** @type {PendingPromptEffect[]} */
    #pendingEffects = [];
    #generationEpoch = 0;
    #freezeStartedAt = 0;
    /** @type {Promise<void> | null} */
    #staleRecoveryPromise = null;

    /**
     * @param {ForegroundGateDeps} deps
     */
    constructor({ reassertInjection, requeue, now = Date.now }) {
        this.#reassertInjection = reassertInjection;
        this.#requeue = requeue;
        this.#now = now;
    }

    /**
     * Freeze prompt-affecting mutations after the beforeFreeze hook runs and the
     * committed injection is reasserted. The hook is the one gate-sanctioned
     * window for pre-freeze prompt writes (ADR-0016): it runs while the gate is
     * still open, before the freeze locks slot content.
     * @param {{ beforeFreeze?: () => void }} [options]
     * @returns {void}
     */
    beginGeneration({ beforeFreeze } = {}) {
        if (beforeFreeze) {
            beforeFreeze();
        }
        this.#reassertInjectionIfOpen();
        this.#foregroundFrozen = true;
        this.#freezeStartedAt = this.#now();
        this.#generationEpoch++;
        info('Foreground freeze on.');
    }

    /**
     * Lift the freeze and flush the work it held, commits before effects.
     * @returns {Promise<void>}
     */
    async endGeneration() {
        if (
            !this.#foregroundFrozen &&
            this.#pendingCommits.length === 0 &&
            this.#pendingEffects.length === 0
        ) {
            return;
        }

        this.#foregroundFrozen = false;
        this.#freezeStartedAt = 0;
        const commits = this.#pendingCommits.length;
        const effects = this.#pendingEffects.length;
        info(`Foreground freeze off; commits=${commits}, effects=${effects} flushed.`);
        await this.#flushPendingCommits();
        await this.#flushPendingEffects();
    }

    /**
     * Commit immediately when safe, otherwise queue until generation finishes.
     * @param {PendingCommit} commit
     * @returns {Promise<CommitResult>}
     */
    async commitWhenSafe(commit) {
        if (this.#foregroundFrozen && !this.#staleRecoveryPromise) {
            await this.heal(`${commit.kind} commit`);
        }

        if (this.#foregroundFrozen) {
            this.#pendingCommits.push(commit);
            debug(`Queued ${commit.kind} commit while foreground generation is active.`);
            return 'queued';
        }

        return await this.#applyCommit(commit);
    }

    /**
     * Run a prompt effect when safe, otherwise queue it. An effect that reports
     * it could not finish stays the gate's to re-run, so a false return must
     * mean the gate closed mid-effect: the flusher keeps going until the queue
     * empties or the freeze lifts.
     * @param {PendingPromptEffect} effect
     * @returns {Promise<PromptEffectResult>}
     */
    async runEffect(effect) {
        // A heal in flight is already clearing the freeze. Awaiting it from a
        // commit or effect that heal itself is flushing would deadlock, so the
        // pre-check queues instead and lets the flush finish.
        if (this.#foregroundFrozen && !this.#staleRecoveryPromise) {
            await this.heal(`${effect.kind} effect`);
        }

        if (this.#foregroundFrozen) {
            this.#pendingEffects.push(effect);
            trace(`Queued ${effect.kind} prompt effect while foreground generation is active.`);
            return 'queued';
        }

        const epoch = this.#generationEpoch;
        if (!this.#hasEpochOpen(epoch)) {
            this.#pendingEffects.push(effect);
            trace(`Queued ${effect.kind} prompt effect against a newer generation.`);
            return 'queued';
        }

        const completed = await effect.apply({
            epoch,
            canContinue: () => this.#hasEpochOpen(epoch),
        });
        if (!completed) {
            this.#pendingEffects.push(effect);
        }
        return completed ? 'applied' : 'queued';
    }

    /**
     * Ask the foreground gate whether prompt-affecting work may start, first
     * attempting to recover a stale freeze so a heal reopens the gate inline.
     * @param {string} reason - Context for diagnostic logging
     * @param {{ refreshUi?: () => void }} [options]
     * @returns {Promise<'open' | 'blocked'>}
     */
    async promptWorkGate(reason, { refreshUi } = {}) {
        await this.heal(reason, { refreshUi });
        return this.#shouldStopPromptWork() ? 'blocked' : 'open';
    }

    /**
     * Clear a stale freeze when SillyTavern is no longer generating. The heal's
     * own flush must apply queued prompt effects and commits, and every effect
     * queued by that flush would otherwise requeue against the heal's in-flight
     * promise forever (an endless microtask loop that freezes the page). A
     * generation starting mid-flush bumps the epoch and sets the freeze, so the
     * epoch check alone gates the race.
     * @param {string} reason - Context for debug logging
     * @param {{ refreshUi?: () => void }} [options]
     * @returns {Promise<boolean>} True when stale guard state was cleared
     */
    async heal(reason, { refreshUi } = {}) {
        if (this.#staleRecoveryPromise) {
            await this.#staleRecoveryPromise;
            if (refreshUi) {
                refreshUi();
            }
            return true;
        }

        if (
            !this.#foregroundFrozen ||
            !this.#hasFreezeGraceElapsed() ||
            this.#isForegroundGenerationActive()
        ) {
            return false;
        }

        warn('Stale foreground freeze detected; auto-healing lock', `reason=${reason}`);
        this.#staleRecoveryPromise = this.endGeneration().finally(() => {
            this.#staleRecoveryPromise = null;
        });
        await this.#staleRecoveryPromise;
        if (refreshUi) {
            refreshUi();
        }
        return true;
    }

    /**
     * Whether prompt mutations are frozen or a heal is still settling.
     * @returns {boolean}
     */
    isFrozen() {
        this.#recoverStaleFreezeInBackground('prompt mutation check');
        return this.#foregroundFrozen || Boolean(this.#staleRecoveryPromise);
    }

    /**
     * Drop transient guard state, as a fresh page load wants.
     * @returns {void}
     */
    reset() {
        this.#foregroundFrozen = false;
        this.#pendingCommits = [];
        this.#pendingEffects = [];
        this.#generationEpoch = 0;
        this.#freezeStartedAt = 0;
        this.#staleRecoveryPromise = null;
    }

    /**
     * Best-effort check for an active SillyTavern foreground generation.
     * @returns {boolean}
     */
    #isForegroundGenerationActive() {
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
     * @returns {boolean}
     */
    #hasFreezeGraceElapsed() {
        return (
            this.#freezeStartedAt === 0 ||
            this.#now() - this.#freezeStartedAt >= FOREGROUND_FREEZE_HEARTBEAT_GRACE_MS
        );
    }

    /**
     * @returns {void}
     */
    #reassertInjectionIfOpen() {
        if (this.#foregroundFrozen || this.#staleRecoveryPromise) {
            return;
        }
        this.#reassertInjection();
    }

    /**
     * Ask whether a running effect may keep going. A frozen gate means a new
     * generation started to replace the one the effect was captured against.
     * @param {number} epoch
     * @returns {boolean}
     */
    #hasEpochOpen(epoch) {
        this.#recoverStaleFreezeInBackground('prompt mutation start');
        return !this.#foregroundFrozen && epoch === this.#generationEpoch;
    }

    /**
     * Clear stale freeze state from synchronous guard checks.
     * @param {string} reason - Context for diagnostic logging
     * @returns {void}
     */
    #recoverStaleFreezeInBackground(reason) {
        if (!this.#foregroundFrozen || this.#staleRecoveryPromise) {
            return;
        }

        void this.heal(reason).catch((error) => {
            warn('Error while recovering foreground generation freeze:', error);
        });
    }

    /**
     * Apply a pending commit and request a fresh worker pass if it went stale.
     * @param {PendingCommit} commit
     * @returns {Promise<CommitResult>}
     */
    async #applyCommit(commit) {
        const applied = await commit.apply();
        if (applied) {
            return 'applied';
        }

        debug(`Discarded stale ${commit.kind} result; requeueing summarization.`);
        this.#requeue(`stale-${commit.kind}`);
        return 'stale';
    }

    /**
     * @returns {Promise<void>}
     */
    async #flushPendingCommits() {
        while (!this.#foregroundFrozen && this.#pendingCommits.length > 0) {
            const commit = this.#pendingCommits.shift();
            if (commit) {
                await this.#applyCommit(commit);
            }
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async #flushPendingEffects() {
        while (!this.#foregroundFrozen && this.#pendingEffects.length > 0) {
            const effect = this.#pendingEffects.shift();
            if (effect) {
                await this.runEffect(effect);
            }
        }
    }

    /**
     * Stop prompt-affecting work while foreground generation or queued work needs priority.
     * @returns {boolean}
     */
    #shouldStopPromptWork() {
        return (
            this.isFrozen() || this.#pendingCommits.length > 0 || this.#pendingEffects.length > 0
        );
    }
}

/**
 * Build the Foreground Gate. The composition root builds one and hands it to
 * its callers, so the freeze, the epoch, and both queues have a single owner.
 * @param {ForegroundGateDeps} deps
 * @returns {ForegroundGate}
 */
export function createForegroundGate(deps) {
    return new ForegroundGate(deps);
}
