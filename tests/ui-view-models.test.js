import { describe, expect, it } from 'vitest';

import { MEMORY_MODES, defaultSettings } from '../src/foundation/constants.js';
import { describeAutoWork } from '../src/core/summarization-routes.js';
import { readSealedMicrofichePlans } from '../src/core/microfiche-pages.js';
import {
    buildAutoWorkBudgetParts,
    buildBacklogSplitModel,
    buildContextBudgetViewModel,
    buildEnabledContentModel,
    buildMicroficheReasonModel,
    buildTriggerGaugeModel,
    formatBudgetTokenLabel,
    getContextColorClass,
} from '../src/entry/ui-view-models.js';
import {
    installSummaryContext,
    makeMemoryInjectionWriter,
    makeSizedChat,
    makeSummaryStore,
    messageLineTokens,
    windowSettings,
} from './test-helpers.js';

const OFF_MODE = { mode: 'off', complexity: 'advanced', enabled: false };
const ON_EASY = { mode: 'on', complexity: 'easy', enabled: true };
const ON_ADVANCED = { mode: 'on', complexity: 'advanced', enabled: true };

describe('context budget color tiers', () => {
    it('keeps counts at or below a threshold in the tier below it', () => {
        expect(getContextColorClass(23999)).toBe('sc-ctx-safe');
        expect(getContextColorClass(24000)).toBe('sc-ctx-safe');
        expect(getContextColorClass(32000)).toBe('sc-ctx-warn');
        expect(getContextColorClass(48000)).toBe('sc-ctx-caution');
    });

    it('crosses into the next tier only strictly above each threshold', () => {
        expect(getContextColorClass(24001)).toBe('sc-ctx-warn');
        expect(getContextColorClass(32001)).toBe('sc-ctx-caution');
        expect(getContextColorClass(48001)).toBe('sc-ctx-danger');
        expect(getContextColorClass(50000)).toBe('sc-ctx-danger');
    });
});

describe('budget token labels', () => {
    it('ceil-normalizes counts and compacts them into k notation', () => {
        expect(formatBudgetTokenLabel(999)).toBe('999');
        expect(formatBudgetTokenLabel(4321.2)).toBe('4k');
        expect(formatBudgetTokenLabel(16000)).toBe('16k');
    });

    it('marks estimated counts with a tilde and normalizes unusable counts to zero', () => {
        expect(formatBudgetTokenLabel(500, true)).toBe('~500');
        expect(formatBudgetTokenLabel(-50.5)).toBe('0');
        expect(formatBudgetTokenLabel(undefined)).toBe('0');
    });
});

describe('context budget view model', () => {
    it('builds a plain-data model with sized segments and a free-space tail', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 2000, estimated: false },
            layers: [{ label: 'Layer 0', kind: 'memory', count: 3000, estimated: true }],
        });

        expect(view).toEqual({
            budget: 16000,
            used: 5000,
            overage: 0,
            denominator: 16000,
            totalLabel: '~5k / 16k',
            marker: null,
            segments: [
                {
                    label: 'Live Chat',
                    kind: 'verbatim',
                    count: 2000,
                    estimated: false,
                    percent: 12.5,
                    small: false,
                },
                {
                    label: 'Layer 0',
                    kind: 'memory',
                    count: 3000,
                    estimated: true,
                    percent: 18.75,
                    small: false,
                },
                {
                    label: 'Free Space',
                    kind: 'free',
                    count: 11000,
                    estimated: false,
                    percent: 68.75,
                    small: false,
                },
            ],
        });
    });

    it('positions the trigger marker as a percent of the denominator', () => {
        const view = buildContextBudgetViewModel({
            budget: 4000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1000, estimated: false },
            layers: [],
            marker: { positionTokens: 1500.4, label: 'Trigger' },
        });

        expect(view.denominator).toBe(4000);
        expect(view.marker).toEqual({ percent: 37.525, label: 'Trigger' });
    });

    it('reports overage past the budget and drops the free-space segment', () => {
        const view = buildContextBudgetViewModel({
            budget: 1000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1200, estimated: false },
            layers: [],
        });

        expect(view.overage).toBe(200);
        expect(view.segments).toEqual([
            {
                label: 'Live Chat',
                kind: 'verbatim',
                count: 1200,
                estimated: false,
                percent: 100,
                small: false,
            },
        ]);
    });

    it('flags segments below eight percent of the bar as small', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1000, estimated: false },
            layers: [{ label: 'Deeper', kind: 'memory', count: 2000, estimated: false }],
        });

        const byLabel = Object.fromEntries(
            view.segments.map((segment) => [segment.label, segment]),
        );
        expect(byLabel['Live Chat'].percent).toBe(6.25);
        expect(byLabel['Live Chat'].small).toBe(true);
        expect(byLabel['Deeper'].percent).toBe(12.5);
        expect(byLabel['Deeper'].small).toBe(false);
    });
});

describe('trigger gauge model', () => {
    it('treats a missing work read model as an empty queue and ceil-normalizes the budget', () => {
        expect(buildTriggerGaugeModel(null, { queuedTokenBudget: 16000.4 })).toEqual({
            queuedTokens: 0,
            queuedEstimated: false,
            triggerTokens: 16001,
            label: 'Summarize at Recent + Queued',
        });
    });
});

describe('billed auto work bars', () => {
    it('bills the sealed frames plus the tail text instead of the live span', async () => {
        const { work, live } = await sealRawPages();

        // Two Google frames bill 2240 tokens and hold 6958 tokens of page
        // text (two 13916-cell frames), so the bars total the frames plus the
        // surviving tail instead of the full live span.
        const billed = 2240 + (live - 6958);
        expect(work.verbatimTokens + work.queuedTokens).toBe(billed);
        expect(work.verbatimTokens + work.queuedTokens).toBeLessThan(live);
        expect(work.verbatimImageTokens).toBe(0);
        expect(work.queuedImageTokens).toBe(2240);
    });

    it('renders the image share as its own segment beside the text tail', async () => {
        const { work } = await sealRawPages();

        const parts = buildAutoWorkBudgetParts(work);
        expect(parts.queued.images).toEqual({
            label: 'Images',
            kind: 'microfiche',
            count: 2240,
            estimated: false,
        });
        expect(parts.recent.images.count).toBe(0);

        const view = buildContextBudgetViewModel({
            budget: 12057,
            verbatim: parts.queued.text,
            layers: [parts.queued.images],
        });
        const kinds = view.segments.map((segment) => segment.kind);
        expect(kinds).toEqual(expect.arrayContaining(['pending', 'microfiche']));
        expect(view.used).toBe(parts.queued.text.count + parts.queued.images.count);
    });
});

/**
 * Synthetic sealed plans: the reason and split builders read only the raw
 * region's cap, kept pages, and over-cap flag, so the cases stay independent
 * of pagination geometry.
 * @param {{ cap: number, images: number, raw: number, overCap: boolean }} input - Raw plan facts.
 * @returns {{ microficheRaw: { effectiveCap: number, imageTexts: string[], rawTexts: string[], overCap: boolean } }}
 */
function rawPlan({ cap, images, raw, overCap }) {
    return {
        microficheRaw: {
            effectiveCap: cap,
            imageTexts: Array.from({ length: images }, (_value, index) => `page ${index}`),
            rawTexts: Array.from({ length: raw }, (_value, index) => `text ${index}`),
            overCap,
        },
    };
}

/**
 * @param {{ backlog?: number, billed?: number, ready?: boolean }} [input] - Read model facts.
 * @returns {import('../src/core/summarization-routes.js').AutoWorkReadModel}
 */
function workModel({ backlog = 0, billed = 0, ready = true } = {}) {
    return {
        ready,
        backlog,
        verbatimTokens: billed,
        verbatimEstimated: false,
        verbatimImageTokens: 0,
        queuedTokens: 0,
        queuedEstimated: false,
        queuedImageTokens: 0,
    };
}

const REASON_SETTINGS = {
    microficheImageCap: 4,
    verbatimTokenBudget: 1000,
    queuedTokenBudget: 1000,
};

describe('microfiche reason model', () => {
    it('says slots full with one waiting page', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 500 }),
                rawPlan({ cap: 4, images: 4, raw: 1, overCap: true }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'photo slots full 4/4, 1 page waits as text — summarize to free a slot',
            memoryNext: true,
        });
    });

    it('pluralizes the waiting pages', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 500 }),
                rawPlan({ cap: 4, images: 4, raw: 3, overCap: true }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'photo slots full 4/4, 3 pages wait as text — summarize to free a slot',
            memoryNext: true,
        });
    });

    it('says budget full when the bucket demotes a page below the cap', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 500 }),
                rawPlan({ cap: 4, images: 1, raw: 1, overCap: true }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'photo budget full — summarize to free room',
            memoryNext: true,
        });
    });

    it('says budget full when the raw bucket shrank the effective cap', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 2000 }),
                rawPlan({ cap: 2, images: 2, raw: 1, overCap: true }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'photo budget full — summarize to free room',
            memoryNext: true,
        });
    });

    it('treats an unaffordable cap of zero as budget full', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 500 }),
                rawPlan({ cap: 0, images: 0, raw: 1, overCap: true }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'photo budget full — summarize to free room',
            memoryNext: true,
        });
    });

    it('stays neutral while imaging proceeds', () => {
        expect(
            buildMicroficheReasonModel(
                workModel({ billed: 500 }),
                rawPlan({ cap: 4, images: 2, raw: 0, overCap: false }),
                REASON_SETTINGS,
            ),
        ).toEqual({
            text: 'imaging 2/4 images',
            memoryNext: false,
        });
    });

    it('stays neutral when no sealed raw plan exists', () => {
        expect(buildMicroficheReasonModel(workModel(), null, REASON_SETTINGS)).toEqual({
            text: 'imaging idle',
            memoryNext: false,
        });
    });
});

describe('backlog split model', () => {
    it('splits the backlog into sealed images plus queued text', () => {
        expect(
            buildBacklogSplitModel(
                workModel({ backlog: 10 }),
                rawPlan({ cap: 4, images: 4, raw: 0, overCap: false }),
            ),
        ).toEqual({ backlog: 10, images: 4, text: 6 });
    });

    it('never counts more sealed images than waiting turns', () => {
        expect(
            buildBacklogSplitModel(
                workModel({ backlog: 3 }),
                rawPlan({ cap: 4, images: 4, raw: 0, overCap: false }),
            ),
        ).toEqual({ backlog: 3, images: 3, text: 0 });
    });

    it('reads a missing work model or raw plan as an empty split', () => {
        expect(buildBacklogSplitModel(null, null)).toEqual({ backlog: 0, images: 0, text: 0 });
        expect(buildBacklogSplitModel(workModel({ backlog: 5 }), { microficheRaw: null })).toEqual({
            backlog: 5,
            images: 0,
            text: 5,
        });
    });

    it('drops the split while no batch is ready', () => {
        expect(
            buildBacklogSplitModel(
                workModel({ backlog: 5, ready: false }),
                rawPlan({ cap: 4, images: 2, raw: 0, overCap: false }),
            ),
        ).toEqual({ backlog: 0, images: 0, text: 0 });
    });
});

/**
 * Seal the full Google pages from a chat that fills the raw bucket, so the
 * bars bill the frames plus the surviving tail. Lengths stay in the stub
 * tokenizer's char scale (one char counts as one token).
 * @returns {Promise<{ work: import('../src/core/summarization-routes.js').AutoWorkReadModel, live: number }>}
 */
async function sealRawPages() {
    const chat = makeSizedChat(6, { userLength: 2000, assistantLength: 2000 });
    const live = 6 * messageLineTokens(true, 2000) + 6 * messageLineTokens(false, 2000);
    const settings = {
        ...defaultSettings,
        ...windowSettings({
            memoryMode: MEMORY_MODES.MICROFICHE,
            microficheGeometry: 'google',
            microficheFrameSize: 1568,
            microficheImageCap: 5,
            microficheKeepRaw: 0,
            microficheFrozenRawImages: true,
            verbatimTokenBudget: live / 2,
            queuedTokenBudget: live / 2,
            minSummaryTurns: 1,
        }),
    };
    const store = makeSummaryStore();
    installSummaryContext({ chat, metadata: { summaryception: store }, settings });
    const writer = makeMemoryInjectionWriter();
    writer.update();
    const sealed = readSealedMicrofichePlans();
    expect(sealed.microficheRaw.imageTexts).toHaveLength(2);
    return { work: await describeAutoWork(chat, store, settings), live };
}

describe('enabled content model', () => {
    it('shows the remembered panel while Off, with no run controls', () => {
        expect(buildEnabledContentModel(OFF_MODE, { autoPaused: false })).toEqual({
            modeLabel: 'Off',
            off: true,
            easyPanel: false,
            advancedPanel: true,
            continuitySection: false,
            stop: false,
            resume: false,
        });
    });

    it('gates the continuity section on the Advanced panel', () => {
        expect(buildEnabledContentModel(ON_ADVANCED, { autoPaused: false }).continuitySection).toBe(
            true,
        );
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: false }).continuitySection).toBe(
            false,
        );
    });

    it('swaps Stop for Resume while the Pause Latch is set', () => {
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: true })).toMatchObject({
            stop: false,
            resume: true,
        });
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: false })).toMatchObject({
            stop: true,
            resume: false,
        });
    });

    it('labels the visible panel', () => {
        expect(buildEnabledContentModel(ON_EASY, {}).modeLabel).toBe('Easy');
        expect(buildEnabledContentModel(ON_ADVANCED, {}).modeLabel).toBe('Advanced');
    });
});
