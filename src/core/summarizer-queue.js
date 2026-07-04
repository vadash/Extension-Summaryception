/** @typedef {'idle' | 'layer0' | 'promoting' | 'yielding' | 'paused'} SummarizerQueuePhase */
/** @typedef {'processed' | 'idle' | 'blocked' | 'failed'} SummarizerQueueCycleResult */

/**
 * @typedef {object} SummarizerQueueContext
 * @property {(phase: SummarizerQueuePhase) => void} setPhase - Update the visible queue phase.
 * @property {() => SummarizerQueuePhase} getPhase - Read the current queue phase.
 */

/**
 * @typedef {object} SummarizerQueueDependencies
 * @property {(ctx: SummarizerQueueContext) => Promise<SummarizerQueueCycleResult>} drainOneCycle
 * @property {() => void} abort
 * @property {() => void} refreshUi
 * @property {<T>(label: string, callback: () => Promise<T>) => Promise<T>} withUsageRun
 * @property {{ log?: (...args: unknown[]) => void } | ((...args: unknown[]) => void)} [logger]
 * @property {() => Promise<void>} [yieldCycle]
 * @property {() => Promise<void>} [afterDrain]
 */

/**
 * Coalesces automatic summarization requests into one self-draining worker.
 */
export class SummarizerQueue {
    /**
     * @param {SummarizerQueueDependencies} deps
     */
    constructor({ drainOneCycle, abort, refreshUi, withUsageRun, logger, yieldCycle, afterDrain }) {
        this.drainOneCycle = drainOneCycle;
        this.abortRequest = abort;
        this.refreshUi = refreshUi;
        this.withUsageRun = withUsageRun;
        this.yieldCycle = yieldCycle || defaultYieldCycle;
        this.afterDrain = afterDrain || defaultAfterDrain;
        this.log = typeof logger === 'function' ? logger : logger?.log;

        this.running = false;
        this.pending = false;
        this.dirty = false;
        this.workerPromise = null;
        this.manualSummarizing = false;
        /** @type {SummarizerQueuePhase} */
        this.phase = 'idle';

        /** @type {SummarizerQueueContext} */
        this.context = {
            setPhase: (phase) => this.#setPhase(phase),
            getPhase: () => this.phase,
        };
    }

    /**
     * Queue or coalesce an automatic summarization request.
     * @returns {Promise<void>}
     */
    request() {
        this.pending = true;

        if (this.running) {
            this.dirty = true;
            return this.workerPromise || Promise.resolve();
        }

        this.workerPromise = this.#drainSummarizationWorker().finally(() => {
            this.workerPromise = null;
        });
        return this.workerPromise;
    }

    /**
     * Abort in-flight summarization and clear queued work.
     * @returns {void}
     */
    abort() {
        this.abortRequest();
        this.pending = false;
        this.dirty = false;
        this.manualSummarizing = false;
        if (!this.running) {
            this.#setPhase('idle');
        }
    }

    /**
     * Check whether the queue or a manual task is active.
     * @returns {boolean}
     */
    getIsSummarizing() {
        return this.running || this.manualSummarizing;
    }

    /**
     * Set the manual summarization busy state.
     * @param {boolean} value
     * @returns {void}
     */
    setSummarizing(value) {
        this.manualSummarizing = Boolean(value);
    }

    /**
     * Read the current worker phase.
     * @returns {SummarizerQueuePhase}
     */
    getPhase() {
        return this.phase;
    }

    /**
     * Drain coalesced work until stable, guarded, or failed.
     * @returns {Promise<void>}
     */
    async #drainSummarizationWorker() {
        await this.withUsageRun('auto worker drain', async () => {
            this.running = true;
            this.refreshUi();

            try {
                await this.#drainRequestedWork();
            } finally {
                try {
                    await this.afterDrain();
                } finally {
                    this.running = false;
                    this.#setPhase('idle', { force: true });
                }
            }
        });
    }

    /**
     * Run requested work, preserving dirty reruns except after failures.
     * @returns {Promise<void>}
     */
    async #drainRequestedWork() {
        let failed = false;

        do {
            this.pending = false;
            this.dirty = false;
            const result = await this.#drainReadyWork();
            failed = result === 'failed';

            if (failed) {
                this.log?.('Summarization cycle failed; waiting for the next trigger.');
                this.pending = false;
                this.dirty = false;
            }
        } while (!failed && (this.pending || this.dirty));
    }

    /**
     * Drain ready automatic work until no immediate work remains.
     * @returns {Promise<SummarizerQueueCycleResult>}
     */
    async #drainReadyWork() {
        while (true) {
            const result = await this.drainOneCycle(this.context);
            if (result === 'blocked') {
                this.#setPhase('paused');
            }
            if (result !== 'processed') {
                return result;
            }

            this.#setPhase('yielding');
            await this.yieldCycle();
        }
    }

    /**
     * Update phase and refresh observers when it changes.
     * @param {SummarizerQueuePhase} phase
     * @param {{ force?: boolean }} [opts]
     * @returns {void}
     */
    #setPhase(phase, { force = false } = {}) {
        if (!isQueuePhase(phase)) {
            throw new Error(`Invalid summarizer queue phase: ${phase}`);
        }
        if (!force && this.phase === phase) {
            return;
        }

        this.phase = phase;
        this.refreshUi();
    }
}

/**
 * Yield to the browser event loop between background work units.
 * @returns {Promise<void>}
 */
async function defaultYieldCycle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function defaultAfterDrain() {}

/**
 * Check whether a value is a supported queue phase.
 * @param {unknown} phase
 * @returns {phase is SummarizerQueuePhase}
 */
function isQueuePhase(phase) {
    return (
        phase === 'idle' ||
        phase === 'layer0' ||
        phase === 'promoting' ||
        phase === 'yielding' ||
        phase === 'paused'
    );
}
