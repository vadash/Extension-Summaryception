/** @typedef {'idle' | 'layer0' | 'promoting' | 'yielding' | 'paused'} SummarizerQueuePhase */
import { sleep } from '../foundation/retry.js';
import { refreshUi } from '../foundation/refresh.js';
import { silentAdapter } from './notify.js';
import { flushPendingChatSave } from './persist-state.js';
import { runElasticAutoCycle } from './summarizer-engine.js';
import {
    abortAllRequests,
    isRequestLive as isSummarizerRequestLive,
} from './summarizer-request.js';
import { withUsageRun } from './summarizer-usage.js';

/**
 * @typedef {object} SummarizerQueueContext
 * @property {(phase: SummarizerQueuePhase) => void} setPhase - Update the visible queue phase.
 * @property {() => SummarizerQueuePhase} getPhase
 */

/**
 * @typedef {object} SummarizerQueueDependencies
 * @property {(ctx: SummarizerQueueContext) => Promise<import('./run-outcome.js').SummarizationRunOutcome>} drainOneCycle - Runs one automatic queue cycle.
 * @property {() => void} abortAllRequests - Aborts every live summarizer request.
 * @property {() => boolean} isRequestLive - Whether any summarizer request is in flight.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 * @property {{ log?: (...args: unknown[]) => void } | ((...args: unknown[]) => void)} [logger] - Optional queue logger.
 * @property {() => Promise<void>} [yieldCycle] - Yields between processed work units.
 * @property {() => Promise<void>} [afterDrain] - Runs after the worker drain completes.
 */

/**
 * @typedef {'manual-run' | 'regeneration'} WorkGateKind
 */

/**
 * @typedef {object} WorkGateRun
 * @property {() => void} end - Release the lease; its owner calls this once its work settles.
 * @property {() => boolean} isStopped - Whether stop() asked this run to stop.
 */

/**
 * Coalesces automatic summarization requests into one self-draining worker.
 */
export class SummarizerQueue {
    /**
     * @param {SummarizerQueueDependencies} deps
     */
    constructor({
        drainOneCycle,
        abortAllRequests,
        isRequestLive,
        refreshUi,
        withUsageRun,
        logger,
        yieldCycle,
        afterDrain,
    }) {
        this.drainOneCycle = drainOneCycle;
        this.abortAllRequests = abortAllRequests;
        this.isRequestLive = isRequestLive;
        this.refreshUi = refreshUi;
        this.withUsageRun = withUsageRun;
        this.yieldCycle = yieldCycle || defaultYieldCycle;
        this.afterDrain = afterDrain || defaultAfterDrain;
        this.log = typeof logger === 'function' ? logger : logger?.log;

        this.running = false;
        this.pending = false;
        this.dirty = false;
        this.workerPromise = null;
        /** Live foreground work leases opened through beginRun. @type {Set<{ kind: WorkGateKind, stopped: boolean }>} */
        this.leases = new Set();
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
     * While a foreground lease is live the request is remembered as dirty and
     * the worker is not started; the next trigger's rerun picks it up.
     * @returns {Promise<void>}
     */
    request() {
        this.pending = true;

        if (this.leases.size > 0) {
            this.dirty = true;
            return Promise.resolve();
        }

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
     * Stop all summarizer work: abort every live request, set the stop intent
     * on all live leases, and drop queued work. Leases are never released
     * here; their owners observe isStopped() and end() themselves.
     * @returns {void}
     */
    stop() {
        this.abortAllRequests();
        for (const lease of this.leases) {
            lease.stopped = true;
        }
        this.pending = false;
        this.dirty = false;
        if (!this.running) {
            this.#setPhase('idle');
        }
    }

    /**
     * Whether any summarizer work is live: the automatic worker, a foreground
     * lease, or a summarizer request.
     * @returns {boolean}
     */
    isBusy() {
        return this.running || this.leases.size > 0 || this.isRequestLive();
    }

    /**
     * Open a foreground work lease. The owner must call end() exactly once
     * when its work settles and treat isStopped() as an external stop.
     * @param {WorkGateKind} kind - What kind of foreground run is starting.
     * @returns {WorkGateRun}
     */
    beginRun(kind) {
        const lease = { kind, stopped: false };
        this.leases.add(lease);
        return {
            end: () => {
                this.leases.delete(lease);
            },
            isStopped: () => lease.stopped,
        };
    }

    /**
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
            failed = result.status === 'failed';

            if (failed) {
                this.log?.('Summarization cycle failed; waiting for the next trigger.');
                this.pending = false;
                this.dirty = false;
            }
        } while (!failed && (this.pending || this.dirty));
    }

    /**
     * Drain ready automatic work until no immediate work remains.
     * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
     */
    async #drainReadyWork() {
        while (true) {
            const result = await this.drainOneCycle(this.context);
            if (result.status === 'blocked') {
                this.#setPhase('paused');
            }
            if (result.status !== 'completed') {
                return result;
            }

            this.#setPhase('yielding');
            await this.yieldCycle();
        }
    }

    /**
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
    await sleep(0);
}

async function defaultAfterDrain() {}

/**
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

/** @type {import('./notify.js').NotifyAdapter} */
let notifyAdapter = silentAdapter;

/**
 * The one summarizer queue instance, built from static core imports.
 * @type {SummarizerQueue}
 */
export const summarizerQueue = new SummarizerQueue({
    drainOneCycle: (queue) => runElasticAutoCycle(queue, { refreshUi, notify: notifyAdapter }),
    abortAllRequests,
    isRequestLive: isSummarizerRequestLive,
    refreshUi,
    withUsageRun,
    yieldCycle: async () => {
        await sleep(0);
    },
    afterDrain: flushPendingChatSave,
});

/**
 * @returns {Promise<void>}
 */
export function requestSummarization() {
    return summarizerQueue.request();
}

/**
 * Whether any summarizer work is live: the automatic worker, a foreground
 * lease, or a summarizer request.
 * @returns {boolean}
 */
export function isBusy() {
    return summarizerQueue.isBusy();
}

/**
 * @returns {boolean}
 */
export function isRequestLive() {
    return summarizerQueue.isRequestLive();
}

/**
 * @returns {void}
 */
export function stopSummarization() {
    summarizerQueue.stop();
}

/**
 * @param {'manual-run' | 'regeneration'} kind
 * @returns {{ end: () => void, isStopped: () => boolean }} Lease handle; caller ends it in finally.
 */
export function beginRun(kind) {
    return summarizerQueue.beginRun(kind);
}

/**
 * Register the notify adapter used by automatic summarization cycles.
 * @param {import('./notify.js').NotifyAdapter | null | undefined} adapter - Toastr-backed adapter from entry, or a falsy value to reset to silent.
 * @returns {void}
 */
export function setNotify(adapter) {
    notifyAdapter = adapter || silentAdapter;
}
