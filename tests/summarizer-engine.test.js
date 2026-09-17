import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    buildForceSummaryRoutePlan: vi.fn(),
    buildSlopSummaryRoutePlan: vi.fn(),
}));
const batchMocks = vi.hoisted(() => ({
    summarizeBatchFromTurns: vi.fn(),
    summarizeAtomicLayer0Partitions: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
    getChatStore: vi.fn(() => ({})),
    getCurrentSummarizedBoundary: vi.fn(),
    getEffectiveSettings: vi.fn(() => ({})),
}));

vi.mock('../src/core/summarization-routes.js', async (importOriginal) => ({
    ...(await importOriginal()),
    ...routeMocks,
}));
vi.mock('../src/core/summarizer-batch.js', () => batchMocks);
vi.mock('../src/foundation/state.js', () => stateMocks);
vi.mock('../src/core/summarizer-promotion.js', () => ({
    drainPromotionOverflow: vi.fn(async () => ({ status: 'completed', attempts: 0 })),
}));
vi.mock('../src/core/persist-state.js', () => ({
    flushPendingChatSave: vi.fn(async () => {}),
    persistChatState: vi.fn(async () => {}),
}));
vi.mock('../src/core/summary-preflight.js', () => ({
    prepareSummaryCycle: vi.fn(async () => ({ chat: [], store: {} })),
}));

import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { ELASTIC_STRATEGIES, runManual } from '../src/core/summarizer-engine.js';
import { installSummaryContext } from './test-helpers.js';

const TARGET_INDEX = 5;
let boundary = 0;

/** Build manual runner deps with a stub queue and its lease handle. */
function makeDeps({ stopAfterFirstBatch = false } = {}) {
    const runToken = { end: vi.fn(), isStopped: vi.fn(() => false) };
    const deps = {
        queue: {
            setPhase: vi.fn(),
            beginRun: vi.fn(() => runToken),
        },
        runToken,
        refreshUi: vi.fn(),
        withUsageRun: vi.fn(async (_label, work) => await work()),
    };
    if (stopAfterFirstBatch) {
        runToken.isStopped.mockImplementation(
            () => batchMocks.summarizeBatchFromTurns.mock.calls.length >= 1,
        );
    }
    return deps;
}

/** Build a ready single-batch force route plan. */
function forceRoutePlan() {
    return {
        ready: true,
        reason: 'ready',
        commitMode: 'TURNS',
        batchTurns: [{ index: 2 }],
        partitions: [{}],
        totalBatches: 1,
        targetIndex: TARGET_INDEX,
    };
}

describe('manual run progress callbacks', () => {
    /** Build a ready route plan; unready once the boundary reaches the target. */
    function stubRoutePlan(mock, plan) {
        mock.mockImplementation(async () => ({
            ...plan,
            ready: boundary < TARGET_INDEX,
            reason: boundary < TARGET_INDEX ? 'ready' : 'none',
        }));
    }

    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        boundary = 0;
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockImplementation(() => boundary);
        // One commit moves the boundary to the target, so the plan turns unready and the run ends after one batch.
        batchMocks.summarizeBatchFromTurns.mockImplementation(async () => {
            boundary = TARGET_INDEX;
            return { status: 'completed' };
        });
    });

    it('reports start and progress for force summarize', async () => {
        stubRoutePlan(routeMocks.buildForceSummaryRoutePlan, forceRoutePlan());
        const onStart = vi.fn();
        const onProgress = vi.fn();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {
            onStart,
            onProgress,
        });

        expect(onStart).toHaveBeenCalledWith({
            completed: 0,
            failed: 0,
            totalBatches: 1,
            label: 'Processing',
            title: 'Summaryception Catch-Up',
        });
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1 }));
        expect(outcome.fullyCommitted).toBe(true);
    });

    it('refreshes the UI after each committed batch', async () => {
        stubRoutePlan(routeMocks.buildForceSummaryRoutePlan, forceRoutePlan());
        // Each commit advances the boundary partway; two commits reach the target.
        batchMocks.summarizeBatchFromTurns.mockImplementation(async () => {
            boundary += 3;
            return { status: 'completed' };
        });

        const deps = makeDeps();
        await runManual(deps, ELASTIC_STRATEGIES.FORCE, {});

        expect(batchMocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
        // One refresh per committed batch plus the end-of-run refresh.
        expect(deps.refreshUi).toHaveBeenCalledTimes(3);
    });

    it('reports start and progress for slop breaker', async () => {
        stubRoutePlan(routeMocks.buildSlopSummaryRoutePlan, {
            ready: true,
            reason: 'ready',
            commitMode: 'TURNS_WITH_SOURCE_END',
            batchTurns: [{ index: 2 }],
            partitions: [{}],
            totalBatches: 1,
            sourceEndIdx: TARGET_INDEX,
            targetIndex: TARGET_INDEX,
        });
        const onStart = vi.fn();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.SLOP, { onStart });

        expect(onStart).toHaveBeenCalledWith({
            completed: 0,
            failed: 0,
            totalBatches: 1,
            label: 'Breaking slop',
            title: 'Summaryception Slop Breaker',
        });
        expect(outcome.fullyCommitted).toBe(true);
    });

    it('cancels before any batch when the signal is already aborted', async () => {
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
        const controller = new AbortController();
        controller.abort();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {
            signal: controller.signal,
        });

        expect(outcome.cancelled).toBe(true);
        expect(batchMocks.summarizeBatchFromTurns).not.toHaveBeenCalled();
    });
});

describe('manual run work gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockReturnValue(0);
        // Every batch fails without moving the summarized boundary.
        batchMocks.summarizeBatchFromTurns.mockResolvedValue({ status: 'failed' });
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('opens one lease and exits cancelled when the gate stops the run', async () => {
        const deps = makeDeps({ stopAfterFirstBatch: true });

        const outcome = await runManual(deps, ELASTIC_STRATEGIES.FORCE, {});

        expect(deps.queue.beginRun).toHaveBeenCalledWith('manual-run');
        expect(deps.runToken.end).toHaveBeenCalledTimes(1);
        expect(batchMocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1);
        expect(outcome.cancelled).toBe(true);
        expect(outcome.failed).toBe(1);
        expect(outcome.failureLimitReached).toBe(false);
    });
});

describe('manual run failure limit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockReturnValue(0);
        // Every batch commit fails without moving the summarized boundary.
        batchMocks.summarizeBatchFromTurns.mockResolvedValue({ status: 'failed' });
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('stops the run after three consecutive batch failures', async () => {
        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.failureLimitReached).toBe(true);
        expect(outcome.failed).toBe(3);
        expect(outcome.completed).toBe(0);
        expect(outcome.fullyCommitted).toBe(false);
        expect(batchMocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(3);
    });

    it('halts as blocked when a completed batch does not move the boundary', async () => {
        // One failure, then a completed batch that never moves the boundary.
        // The blocked halt must stop the run before the two trailing failures.
        batchMocks.summarizeBatchFromTurns
            .mockResolvedValueOnce({ status: 'failed' })
            .mockResolvedValueOnce({ status: 'completed' })
            .mockResolvedValueOnce({ status: 'failed' })
            .mockResolvedValueOnce({ status: 'failed' });

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.blocked).toBe(true);
        expect(outcome.failureLimitReached).toBe(false);
        expect(outcome.failed).toBe(1);
        expect(outcome.completed).toBe(0);
        expect(batchMocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
    });
});
