import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    buildForceSummaryRoutePlan: vi.fn(),
    buildSlopSummaryRoutePlan: vi.fn(),
}));
const layer0Mocks = vi.hoisted(() => ({
    runLayer0: vi.fn(),
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
vi.mock('../src/core/layer0-run.js', () => layer0Mocks);
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

import {
    beginForegroundGeneration,
    resetCommitStateForTests,
} from '../src/core/summarizer-commit.js';
import { ELASTIC_STRATEGIES, runManual } from '../src/core/summarizer-engine.js';
import { SUMMARY_COMMIT_MODES } from '../src/core/summarization-routes.js';
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
        runToken.isStopped.mockImplementation(() => layer0Mocks.runLayer0.mock.calls.length >= 1);
    }
    return deps;
}

/** Build a ready single-batch force route plan. */
function forceRoutePlan() {
    return {
        ready: true,
        reason: 'ready',
        commitMode: SUMMARY_COMMIT_MODES.TURNS,
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
        layer0Mocks.runLayer0.mockImplementation(async () => {
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
        });
        expect(onProgress).toHaveBeenCalledWith({
            completed: 1,
            failed: 0,
            totalBatches: 1,
        });
        expect(outcome.status).toBe('completed');
    });

    it('refreshes the UI after each committed batch', async () => {
        stubRoutePlan(routeMocks.buildForceSummaryRoutePlan, forceRoutePlan());
        // Each commit advances the boundary partway; two commits reach the target.
        layer0Mocks.runLayer0.mockImplementation(async () => {
            boundary += 3;
            return { status: 'completed' };
        });

        const deps = makeDeps();
        await runManual(deps, ELASTIC_STRATEGIES.FORCE, {});

        expect(layer0Mocks.runLayer0).toHaveBeenCalledTimes(2);
        // One refresh per committed batch plus the end-of-run refresh.
        expect(deps.refreshUi).toHaveBeenCalledTimes(3);
    });

    it('reports start and progress for slop breaker', async () => {
        stubRoutePlan(routeMocks.buildSlopSummaryRoutePlan, {
            ready: true,
            reason: 'ready',
            commitMode: SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END,
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
        });
        expect(outcome.status).toBe('completed');
    });

    it('aborts before any batch when the signal is already aborted', async () => {
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
        const controller = new AbortController();
        controller.abort();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {
            signal: controller.signal,
        });

        expect(outcome.status).toBe('aborted');
        expect(layer0Mocks.runLayer0).not.toHaveBeenCalled();
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
        layer0Mocks.runLayer0.mockResolvedValue({ status: 'failed' });
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('opens one lease and exits aborted when the gate stops the run', async () => {
        const deps = makeDeps({ stopAfterFirstBatch: true });

        const outcome = await runManual(deps, ELASTIC_STRATEGIES.FORCE, {});

        expect(deps.queue.beginRun).toHaveBeenCalledWith('manual-run');
        expect(deps.runToken.end).toHaveBeenCalledTimes(1);
        expect(layer0Mocks.runLayer0).toHaveBeenCalledTimes(1);
        expect(outcome.status).toBe('aborted');
        expect(outcome.failed).toBe(1);
    });
});

describe('manual run pre-run outcomes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockReturnValue(0);
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('reports idle when the route plan finds no eligible work', async () => {
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue({ ready: false, reason: 'none' });

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome).toEqual({ status: 'idle', completed: 0, failed: 0, totalBatches: 0 });
        expect(layer0Mocks.runLayer0).not.toHaveBeenCalled();
    });

    it('reports blocked with no batches when the gate closed before the run', async () => {
        beginForegroundGeneration();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome).toEqual({ status: 'blocked', completed: 0, failed: 0, totalBatches: 0 });
        expect(layer0Mocks.runLayer0).not.toHaveBeenCalled();
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
        layer0Mocks.runLayer0.mockResolvedValue({ status: 'failed' });
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('stops the run after three consecutive batch failures', async () => {
        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.status).toBe('failed');
        expect(outcome.failed).toBe(3);
        expect(outcome.completed).toBe(0);
        expect(layer0Mocks.runLayer0).toHaveBeenCalledTimes(3);
    });

    it('halts as blocked when a completed run leaves the boundary where it was', async () => {
        // One failure, then a completed run that never moves the boundary. The
        // blocked halt must stop the run, so the default failed result the loop
        // would keep drawing never reaches the tally.
        layer0Mocks.runLayer0
            .mockResolvedValueOnce({ status: 'failed' })
            .mockResolvedValueOnce({ status: 'completed' });

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.status).toBe('blocked');
        expect(outcome.failed).toBe(1);
        expect(outcome.completed).toBe(0);
        expect(layer0Mocks.runLayer0).toHaveBeenCalledTimes(2);
    });
});

describe('manual run gate outcome', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockReturnValue(0);
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('halts as blocked, without a failure, when the run reports the gate blocked', async () => {
        layer0Mocks.runLayer0.mockResolvedValue({ status: 'blocked' });

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome).toEqual({ status: 'blocked', completed: 0, failed: 0, totalBatches: 1 });
        expect(layer0Mocks.runLayer0).toHaveBeenCalledTimes(1);
    });
});
