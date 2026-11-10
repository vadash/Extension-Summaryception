import { describe, expect, it } from 'vitest';

import { MEMORY_MODES } from '../src/foundation/constants.js';
import { estimateTextTokens } from '../src/core/token-count.js';
import { buildInjection } from '../src/core/memory-injection.js';
import { buildMicrofichePageTexts } from '../src/core/microfiche-paginate.js';
import {
    buildMicrofichePlan,
    buildMicroficheRawPlan,
    resolveMicroficheEffectiveCap,
} from '../src/core/microfiche-policy.js';
import { makeRawChatSlice } from './test-helpers.js';

const GEMINI_KNOBS = {
    microficheFont: '8x8',
    microficheCellWidth: 8,
    microficheCellHeight: 22,
    microficheStretch: false,
    microficheVariant: 'bw',
    microficheStopwordDim: false,
    microficheColumns: 1,
    microficheLineRepeat: 1,
    microficheFrameSize: 2048,
};

const TINY = { ...GEMINI_KNOBS, microficheFrameSize: 64 };

const SNIPPETS = [
    'aaa bbb ccc ddd eee',
    'fff ggg hhh iii jjj',
    'kkk lll mmm nnn ooo',
    'ppp qqq rrr sss ttt',
    'uuu vvv www xxx yyy',
    'zza bbb ccc ddd eee',
    'fff ggg hhh iii jjj',
    'kkk lll mmm nnn ooo',
];

describe('microfiche resolveMicroficheEffectiveCap', () => {
    it('takes the smallest finite non-negative budget', () => {
        expect(resolveMicroficheEffectiveCap(8, 3, 200)).toBe(3);
        expect(resolveMicroficheEffectiveCap(80, undefined, 5)).toBe(5);
        expect(resolveMicroficheEffectiveCap(8, 10, undefined)).toBe(8);
    });

    it('floors to an integer at or above zero', () => {
        expect(resolveMicroficheEffectiveCap(2.9, undefined, undefined)).toBe(2);
        expect(resolveMicroficheEffectiveCap(-4, 8, 200)).toBe(0);
        expect(resolveMicroficheEffectiveCap('bogus', -1, Number.NaN)).toBe(0);
    });

    it('ignores absent budgets and keeps the slider cap', () => {
        expect(resolveMicroficheEffectiveCap(8, undefined, undefined)).toBe(8);
        expect(resolveMicroficheEffectiveCap(8, null, null)).toBe(8);
    });
});

describe('microfiche buildMicrofichePlan', () => {
    it('reconciles the slider cap when host and preset budgets are unbounded', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'google',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const plan = buildMicrofichePlan(SNIPPETS, settings, {});
        expect(plan.effectiveCap).toBe(8);
        expect(plan.imageTexts.length).toBe(8);
    });

    it('takes the min of slider, host, and preset budgets', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'google',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const hosted = buildMicrofichePlan(SNIPPETS, settings, { imageBudget: 3 });
        expect(hosted.effectiveCap).toBe(3);
        expect(hosted.imageTexts.length).toBe(3);

        const anthropic = buildMicrofichePlan(SNIPPETS, {
            ...settings,
            microficheGeometry: 'anthropic',
            microficheImageCap: 80,
        });
        expect(anthropic.effectiveCap).toBe(5);
        expect(anthropic.imageTexts.length).toBe(5);
    });

    it('reads no preset budget for custom geometry', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'custom',
            microficheKeepRaw: 0,
            microficheImageCap: 2,
        };
        const plan = buildMicrofichePlan(SNIPPETS, settings, { imageBudget: 80 });
        expect(plan.effectiveCap).toBe(2);
        expect(plan.imageTexts.length).toBe(2);
    });

    it('sends every page to raw text when the host budget is zero', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'google',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const plan = buildMicrofichePlan(SNIPPETS, settings, { imageBudget: 0 });
        expect(plan.effectiveCap).toBe(0);
        expect(plan.imageTexts).toEqual([]);
        expect(plan.rawTexts.length).toBeGreaterThan(0);
    });

    it('splits the built injection by the resolved cap across the cap matrix', () => {
        const cases = [
            [
                'slider cap',
                {
                    ...TINY,
                    memoryMode: MEMORY_MODES.MICROFICHE,
                    microficheGeometry: 'google',
                    microficheKeepRaw: 0,
                    microficheImageCap: 80,
                },
                {},
            ],
            [
                'host cap',
                {
                    ...TINY,
                    memoryMode: MEMORY_MODES.MICROFICHE,
                    microficheGeometry: 'google',
                    microficheKeepRaw: 0,
                    microficheImageCap: 8,
                },
                { imageBudget: 3 },
            ],
            [
                'anthropic preset cap',
                {
                    ...TINY,
                    memoryMode: MEMORY_MODES.MICROFICHE,
                    microficheGeometry: 'anthropic',
                    microficheKeepRaw: 0,
                    microficheImageCap: 80,
                },
                null,
            ],
            [
                'custom',
                {
                    ...TINY,
                    memoryMode: MEMORY_MODES.MICROFICHE,
                    microficheGeometry: 'custom',
                    microficheKeepRaw: 0,
                    microficheImageCap: 2,
                },
                { imageBudget: 80 },
            ],
            [
                'host zero',
                {
                    ...TINY,
                    memoryMode: MEMORY_MODES.MICROFICHE,
                    microficheGeometry: 'google',
                    microficheKeepRaw: 0,
                    microficheImageCap: 8,
                },
                { imageBudget: 0 },
            ],
        ];
        for (const [, settings, host] of cases) {
            const plan = buildMicrofichePlan(SNIPPETS, settings, host);
            const injection = buildInjection([SNIPPETS.map((text) => ({ text }))], settings, host);
            expect(injection.microfiche.imageTexts.length).toBe(plan.imageTexts.length);
        }
    });

    it('carries the resolved shape and the preset frame token estimate', () => {
        const cases = [
            ['google', 1120],
            ['openai', 994],
            ['anthropic', 3136],
            ['custom', 0],
        ];
        for (const [geometry, frameTokenEstimate] of cases) {
            const plan = buildMicrofichePlan(SNIPPETS, {
                ...TINY,
                microficheGeometry: geometry,
                microficheKeepRaw: 0,
                microficheImageCap: 8,
            });
            expect(plan.shape).toMatchObject({ font: '8x8', frameSize: 64 });
            expect(plan.frameTokenEstimate).toBe(frameTokenEstimate);
        }
    });
});

describe('microfiche page imaging and bucket debit', () => {
    const settings = {
        ...TINY,
        microficheGeometry: 'custom',
        microficheKeepRaw: 0,
        microficheImageCap: 8,
    };

    it('images a partial trailing page when the cap has room', () => {
        const plan = buildMicrofichePlan([`${'a'.repeat(16)}${'b'.repeat(4)}`], settings, {});
        expect(plan.imageTexts).toEqual(['a'.repeat(16), 'b'.repeat(4)]);
        expect(plan.rawTexts).toEqual([]);
    });

    it('images every page, including a sentence-broken trailing page', () => {
        const text = `a.${'b'.repeat(14)}${'c'.repeat(6)}`;
        const plan = buildMicrofichePlan([text], settings, {});
        expect(plan.imageTexts).toEqual(['a.', `${'b'.repeat(14)}cc`, 'cccc']);
        expect(plan.rawTexts).toEqual([]);
    });

    it('images every memory snippet regardless of the keep-raw setting', () => {
        const texts = Array.from({ length: 8 }, (_value, index) => `msg${index} ${'x'.repeat(16)}`);
        const plan = buildMicrofichePlan(
            texts,
            { ...settings, microficheKeepRaw: 4, microficheImageCap: 80 },
            {},
        );
        const pages = buildMicrofichePageTexts(texts, plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(8);
        expect(plan.imageTexts).toEqual(pages);
        expect(plan.rawTexts).toEqual([]);
    });

    it('bills images against the raw bucket and keeps overflow as text', () => {
        const bucketSettings = {
            ...TINY,
            microficheGeometry: 'google',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
            verbatimTokenBudget: 1125,
            queuedTokenBudget: 1125,
        };
        const plan = buildMicrofichePlan(['a'.repeat(96)], bucketSettings, {});
        expect(plan.imageTexts.length).toBe(1);
        expect(plan.rawTexts.length).toBe(5);
    });
});

describe('microfiche frozen-raw bucket billing', () => {
    const rawSettings = {
        ...GEMINI_KNOBS,
        microficheGeometry: 'google',
        microficheKeepRaw: 0,
        microficheFrozenRawImages: true,
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
    };

    function billedRawTokens(plan) {
        const frameTokens = plan.imageTexts.length * plan.frameTokenEstimate;
        const tailTokens = plan.rawTexts.reduce((sum, text) => sum + estimateTextTokens(text), 0);
        return frameTokens + tailTokens;
    }

    it('bills the raw shipped tail inside the shared bucket', () => {
        const plan = buildMicroficheRawPlan(
            ['word '.repeat(28800)],
            { ...rawSettings, microficheFrameSize: 256, microficheImageCap: 8 },
            {},
        );
        const bucket = rawSettings.verbatimTokenBudget + rawSettings.queuedTokenBudget;
        expect(billedRawTokens(plan)).toBeLessThanOrEqual(bucket);
    });

    it('reports over-cap when pages wait on a zero bucket cap', () => {
        const plan = buildMicroficheRawPlan(
            ['x'.repeat(18000)],
            {
                ...rawSettings,
                microficheImageCap: 8,
                verbatimTokenBudget: 0,
                queuedTokenBudget: 0,
            },
            {},
        );
        expect(plan.effectiveCap).toBe(0);
        expect(plan.imageTexts).toEqual([]);
        expect(plan.overCap).toBe(true);
    });

    it('reports over-cap when the image cap leaves a page as text', () => {
        const plan = buildMicroficheRawPlan(
            [`a.${'b'.repeat(14)}${'c'.repeat(4)}`],
            { ...rawSettings, microficheFrameSize: 64, microficheImageCap: 2 },
            {},
        );
        expect(plan.imageTexts).toHaveLength(2);
        expect(plan.rawTexts).toHaveLength(1);
        expect(plan.overCap).toBe(true);
        expect(plan.overflowPages).toBe(1);
    });

    it('caps images by the bucket when a frame costs less than its page text', () => {
        const plan = buildMicroficheRawPlan(
            makeRawChatSlice(9),
            {
                ...rawSettings,
                microficheImageCap: 8,
                verbatimTokenBudget: 5000,
                queuedTokenBudget: 5000,
            },
            {},
        );
        const pages = buildMicrofichePageTexts(makeRawChatSlice(9), plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(8);
        expect(plan.effectiveCap).toBe(8);
        expect(plan.imageTexts).toEqual(pages.slice(0, 8));
        expect(plan.rawTexts).toEqual(pages.slice(8));
        expect(plan.overCap).toBe(true);
    });
});

describe('microfiche raw keep-text tail', () => {
    const rawSettings = {
        ...GEMINI_KNOBS,
        microficheGeometry: 'google',
        microficheKeepRaw: 0,
        microficheFrozenRawImages: true,
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
    };

    it('keeps the newest raw messages whole and slides the tail as chat grows', () => {
        const slice = makeRawChatSlice(4);
        const settings = {
            ...rawSettings,
            microficheKeepRaw: 2,
            microficheFrameSize: 512,
            microficheImageCap: 8,
        };
        const before = buildMicroficheRawPlan(slice, settings, {});
        expect(before.rawTexts.slice(-2)).toEqual(slice.slice(-2));
        expect(before.rawTexts.slice(0, -2).length).toBeGreaterThan(0);

        const grown = [...slice, `Message 4 ${'lorem ipsum dolor sit amet '.repeat(600)}`];
        const after = buildMicroficheRawPlan(grown, settings, {});
        expect(after.rawTexts.slice(-2)).toEqual(grown.slice(-2));
        expect(after.rawTexts.slice(-2)).not.toEqual(before.rawTexts.slice(-2));
    });

    it('images every emitted raw page when the keep count is zero', () => {
        const slice = makeRawChatSlice(2);
        const settings = { ...rawSettings, microficheKeepRaw: 0, microficheImageCap: 80 };
        const plan = buildMicroficheRawPlan(slice, settings, {});
        const pages = buildMicrofichePageTexts(slice, plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(0);
        expect(plan.imageTexts).toEqual(pages);
        expect(plan.rawTexts).toEqual([]);
        expect(plan.overCap).toBe(false);
    });

    it('orders overspill pages before the kept tail', () => {
        const slice = makeRawChatSlice(3);
        const plan = buildMicroficheRawPlan(
            slice,
            { ...rawSettings, microficheKeepRaw: 1, microficheImageCap: 1 },
            {},
        );
        const pages = buildMicrofichePageTexts(slice.slice(0, 2), plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(1);
        expect(plan.imageTexts).toEqual(pages.slice(0, 1));
        expect(plan.rawTexts).toEqual([...pages.slice(1), slice[2]]);
        expect(plan.overCap).toBe(true);
    });

    it('works with no memory snippets and still applies the Keep Raw tail', () => {
        const slice = makeRawChatSlice(4);
        const plan = buildMicroficheRawPlan(
            slice,
            { ...rawSettings, microficheKeepRaw: 2, microficheImageCap: 8 },
            {},
            null,
        );
        expect(plan.imageTexts.length).toBeGreaterThan(0);
        expect(plan.rawTexts.slice(-2)).toEqual(slice.slice(-2));
    });

    it('counts the kept tail in the bucket so tail spend can demote every frame', () => {
        const slice = makeRawChatSlice(4);
        const plan = buildMicroficheRawPlan(
            slice,
            {
                ...rawSettings,
                microficheKeepRaw: 2,
                microficheFrameSize: 256,
                microficheImageCap: 8,
                verbatimTokenBudget: 5000,
                queuedTokenBudget: 4000,
            },
            {},
        );
        const pages = buildMicrofichePageTexts(slice.slice(0, 2), plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(8);
        expect(plan.imageTexts).toEqual([]);
        expect(plan.rawTexts).toEqual([...pages, slice[2], slice[3]]);
        expect(plan.overCap).toBe(true);
    });
});
