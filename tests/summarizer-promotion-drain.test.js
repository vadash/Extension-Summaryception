import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import {
    beginForegroundGeneration,
    resetCommitStateForTests,
} from '../src/core/summarizer-commit.js';
import { drainPromotionOverflow } from '../src/core/summarizer-promotion.js';
import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import {
    installBrowserRuntimeStub,
    installOverflowingStore,
    installSummaryContext,
    makeNotifyRecorder,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

/**
 * drainPromotionOverflow is the single owner of overflow clearing: one loop,
 * one failure budget, one Foreground Gate. Tests drive the real module through its
 * interface with a mocked summarizer request.
 */
describe('drainPromotionOverflow', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        resetCommitStateForTests();
        delete globalThis.toastr;
    });
    function installSettledStore() {
        installSummaryContext({
            metadata: { summaryception: makeSummaryStore() },
            settings: makeSummarySettings({ memoryTokenBudget: 4000 }),
        });
    }

    it('returns completed with zero attempts when no layer overflows', async () => {
        installSettledStore();

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'completed',
            attempts: 0,
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('treats a floor-refused candidate as nothing to promote', async () => {
        // 21 snippets over the count quota of 20, but ~1071 tokens: promoting
        // 3 leaves ~918 tokens below the 2400 retention floor (quota 6000).
        const snippets = Array.from({ length: 21 }, (_, i) => ({
            text: 'x'.repeat(51) + i,
            sourceMessageIds: [`msg-${i}`],
        }));
        installSummaryContext({
            metadata: { summaryception: makeSummaryStore({ layers: [snippets] }) },
            settings: makeSummarySettings({ memoryTokenBudget: 10000, snippetsPerLayer: 20 }),
        });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 3 })).resolves.toEqual({
            status: 'completed',
            attempts: 0,
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('stops after one consecutive failed promotion at the auto budget', async () => {
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'failed',
            attempts: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('tolerates three consecutive failures at the manual budget', async () => {
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 3 })).resolves.toEqual({
            status: 'failed',
            attempts: 3,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(3);
    });

    it('reports blocked before the first attempt when the stop guard trips', async () => {
        installOverflowingStore();
        beginForegroundGeneration();

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'blocked',
            attempts: 0,
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('reports blocked after an attempt when the stop guard trips mid-drain', async () => {
        installOverflowingStore();
        callSummarizer.mockImplementation(async () => {
            beginForegroundGeneration();
            return { status: 'failed' };
        });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 3 })).resolves.toEqual({
            status: 'blocked',
            attempts: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('emits one structured promotion-started event and never calls toastr', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(
            drainPromotionOverflow({ maxConsecutiveFailures: 1, notify: recorder }),
        ).resolves.toEqual({
            status: 'failed',
            attempts: 1,
        });

        expect(toastr.info).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.PROMOTION_STARTED,
                mergedCount: 3,
                fromLayer: 0,
                toLayer: 1,
            },
        ]);
    });
});
