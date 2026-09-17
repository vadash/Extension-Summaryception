import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import { generateValidatedPromotion } from '../src/core/promotion-candidate.js';
import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import {
    installSummaryContext,
    makeNotifyRecorder,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

/**
 * The setup context installs a length-based test tokenizer and a
 * layer0SummaryTokenTarget of 100, so a Layer 0 promotion accepts 40..175
 * tokens and rejects anything outside that band.
 */

const settings = makeSummarySettings({ layer0SummaryTokenTarget: 100 });
const GOOD_NARRATIVE = 'word '.repeat(30).trim(); // 149 tokens: inside the band
const SHORT_NARRATIVE = 'short'; // 5 tokens: under the 40-token floor
const LONG_NARRATIVE = 'word '.repeat(40).trim(); // 199 tokens: over the 175 hard max
function overflowLayers() {
    return Array.from({ length: 4 }, (_, i) => ({
        text: 'x'.repeat(1000),
        sourceMessageIds: [`msg-a-${i}`],
    }));
}
function installStore(layers = [overflowLayers()]) {
    installSummaryContext({
        metadata: { summaryception: makeSummaryStore({ layers }) },
        settings,
    });
}

// Store snippets must carry provenance or normalizeChatStore drops them.
function makePrepared(overrides = {}) {
    const toMerge = overflowLayers().slice(0, 3);
    const storyTxt = toMerge.map((snippet) => snippet.text).join('\n\n');
    return {
        layerIndex: 0,
        settings,
        mergeCount: 3,
        toMerge,
        sourceNarrativeText: storyTxt,
        memoryTokensBefore: { count: 400, estimated: false },
        storyTxt,
        contextStr: 'context',
        promotedMetadata: { sourceMessageIds: ['msg-0', 'msg-2'] },
        promotionMetadata: { kind: 'promotion', layerIndex: 0 },
        ...overrides,
    };
}

describe('generateValidatedPromotion', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        resetCommitStateForTests();
        delete globalThis.toastr;
    });

    it('accepts a first-pass promotion that fits the size band and compresses memory', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        const prepared = makePrepared();
        callSummarizer.mockResolvedValue({ status: 'completed', text: GOOD_NARRATIVE });

        const result = await generateValidatedPromotion(prepared, recorder);

        expect(result).toEqual({ text: GOOD_NARRATIVE, sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(callSummarizer.mock.calls[0]).toEqual([
            prepared.storyTxt,
            prepared.contextStr,
            prepared.promotionMetadata,
            recorder,
        ]);
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

    it('repairs an over-merged output once and accepts the repaired summary', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        const prepared = makePrepared();
        callSummarizer
            .mockResolvedValueOnce({ status: 'completed', text: SHORT_NARRATIVE })
            .mockResolvedValueOnce({ status: 'completed', text: GOOD_NARRATIVE });

        const result = await generateValidatedPromotion(prepared, recorder);

        expect(result).toEqual({ text: GOOD_NARRATIVE, sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(callSummarizer).toHaveBeenCalledTimes(2);
        const [storyTxt, contextStr, metadata, notify] = callSummarizer.mock.calls[1];
        expect(storyTxt).toBe(prepared.storyTxt);
        expect(contextStr).toBe(prepared.contextStr);
        expect(notify).toBe(recorder);
        expect(metadata.promotionRepair).toMatchObject({
            reason: 'too-short',
            outputTokens: SHORT_NARRATIVE.length,
            sourceTokens: 400,
            rejectedSummary: SHORT_NARRATIVE,
        });
        // The repair pass reuses the generation's single notify event.
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

    it('repairs an oversized output once and rejects when the repair still misses', async () => {
        installStore();
        const prepared = makePrepared();
        callSummarizer
            .mockResolvedValueOnce({ status: 'completed', text: LONG_NARRATIVE })
            .mockResolvedValueOnce({ status: 'completed', text: SHORT_NARRATIVE });

        const result = await generateValidatedPromotion(prepared, makeNotifyRecorder());

        expect(result).toBeNull();
        expect(callSummarizer).toHaveBeenCalledTimes(2);
        expect(callSummarizer.mock.calls[1][2].promotionRepair).toMatchObject({
            reason: 'compression-ratio',
            outputTokens: LONG_NARRATIVE.length,
            hardMaxTokens: 175,
        });
    });

    it('rejects output that fails the integrity guard without a repair pass', async () => {
        installStore();
        const prepared = makePrepared({
            memoryTokensBefore: { count: 3000, estimated: false },
        });
        callSummarizer.mockResolvedValue({ status: 'completed', text: SHORT_NARRATIVE });

        const result = await generateValidatedPromotion(prepared, makeNotifyRecorder());

        expect(result).toBeNull();
        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(callSummarizer.mock.calls[0][2]).toEqual(prepared.promotionMetadata);
    });

    it('rejects a valid-sized promotion that does not compress memory', async () => {
        installStore([
            [
                { text: 'a', sourceMessageIds: ['m-1'] },
                { text: 'b', sourceMessageIds: ['m-2'] },
                { text: 'c', sourceMessageIds: ['m-3'] },
            ],
        ]);
        const prepared = makePrepared();
        callSummarizer.mockResolvedValue({ status: 'completed', text: GOOD_NARRATIVE });

        const result = await generateValidatedPromotion(prepared, makeNotifyRecorder());

        expect(result).toBeNull();
        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('returns null and stays silent beyond the notify event when the request fails', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        const result = await generateValidatedPromotion(makePrepared(), recorder);

        expect(result).toBeNull();
        expect(callSummarizer).toHaveBeenCalledTimes(1);
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

    it('returns null when the narrative carries no usable summary', async () => {
        installStore();
        callSummarizer.mockResolvedValue({ status: 'completed', text: '' });

        const result = await generateValidatedPromotion(makePrepared(), makeNotifyRecorder());

        expect(result).toBeNull();
        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });
});
