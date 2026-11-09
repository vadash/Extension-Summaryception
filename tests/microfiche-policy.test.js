import { describe, expect, it } from 'vitest';

import {
    buildMicrofichePlan,
    resolveMicroficheEffectiveCap,
    splitMicroficheTexts,
} from '../src/core/microfiche-policy.js';
import { buildMicrofichePageTexts } from '../src/core/microfiche-paginate.js';

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

function uncappedPages(texts, shape) {
    return buildMicrofichePageTexts(texts, shape).imageTexts;
}

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

describe('microfiche splitMicroficheTexts', () => {
    it('sends the oldest to images and keeps the newest K raw', () => {
        expect(splitMicroficheTexts(['a', 'b', 'c', 'd'], 2)).toEqual({
            imageTexts: ['a', 'b'],
            rawTexts: ['c', 'd'],
        });
    });

    it('sends everything to images when keepRaw is 0', () => {
        expect(splitMicroficheTexts(['a', 'b'], 0)).toEqual({
            imageTexts: ['a', 'b'],
            rawTexts: [],
        });
    });

    it('keeps everything raw when keepRaw covers the input', () => {
        expect(splitMicroficheTexts(['a', 'b'], 2)).toEqual({
            imageTexts: [],
            rawTexts: ['a', 'b'],
        });
        expect(splitMicroficheTexts(['a', 'b'], 9)).toEqual({
            imageTexts: [],
            rawTexts: ['a', 'b'],
        });
    });

    it('handles empty input', () => {
        expect(splitMicroficheTexts([], 2)).toEqual({ imageTexts: [], rawTexts: [] });
    });
});

describe('microfiche buildMicrofichePlan', () => {
    it('caps image pages at the slider with unbounded host and preset budgets', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'gemini',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const plan = buildMicrofichePlan(SNIPPETS, settings, {});
        const uncapped = uncappedPages(SNIPPETS, plan.shape);
        expect(uncapped.length).toBeGreaterThan(8);
        expect(plan.effectiveCap).toBe(8);
        expect(plan.imageTexts).toEqual(uncapped.slice(0, 8));
        expect(plan.rawTexts).toEqual(uncapped.slice(8));
    });

    it('takes the min of slider, host, and preset budgets', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'gemini',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const hosted = buildMicrofichePlan(SNIPPETS, settings, { imageBudget: 3 });
        const uncapped = uncappedPages(SNIPPETS, hosted.shape);
        expect(hosted.effectiveCap).toBe(3);
        expect(hosted.imageTexts).toEqual(uncapped.slice(0, 3));
        expect(hosted.rawTexts).toEqual(uncapped.slice(3));

        const glm = buildMicrofichePlan(SNIPPETS, {
            ...settings,
            microficheGeometry: 'glm',
            microficheImageCap: 80,
        });
        expect(glm.effectiveCap).toBe(5);
        expect(glm.imageTexts).toEqual(uncappedPages(SNIPPETS, glm.shape).slice(0, 5));
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
        expect(plan.imageTexts).toEqual(uncappedPages(SNIPPETS, plan.shape).slice(0, 2));
    });

    it('sends every page to raw text when the host budget is zero', () => {
        const settings = {
            ...TINY,
            microficheGeometry: 'gemini',
            microficheKeepRaw: 0,
            microficheImageCap: 8,
        };
        const plan = buildMicrofichePlan(SNIPPETS, settings, { imageBudget: 0 });
        expect(plan.effectiveCap).toBe(0);
        expect(plan.imageTexts).toEqual([]);
        expect(plan.rawTexts).toEqual(uncappedPages(SNIPPETS, plan.shape));
    });

    it('orders overflow pages before the kept-raw tail', () => {
        const texts = [
            'one alpha one two',
            'two beta two three',
            'three gamma three',
            'four delta four',
        ];
        const settings = {
            ...TINY,
            microficheGeometry: 'custom',
            microficheImageCap: 2,
            microficheKeepRaw: 2,
        };
        const plan = buildMicrofichePlan(texts, settings, {});
        const split = splitMicroficheTexts(texts, 2);
        const pages = uncappedPages(split.imageTexts, plan.shape);
        expect(pages.length).toBeGreaterThan(2);
        expect(plan.keepRaw).toBe(2);
        expect(plan.imageTexts).toEqual(pages.slice(0, 2));
        expect(plan.rawTexts).toEqual([...pages.slice(2), ...split.rawTexts]);
    });

    it('carries the resolved shape and the preset frame token estimate', () => {
        const cases = [
            ['gemini', 1120],
            ['deepseek', 994],
            ['glm', 3136],
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
