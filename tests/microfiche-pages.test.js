import { beforeAll, describe, expect, it } from 'vitest';

import { DIM_OFF, DIM_ON, NEWLINE_GLYPH } from '../src/core/microfiche-normalize.js';
import {
    buildMicrofichePageTexts,
    resolveMicroficheShape,
} from '../src/core/microfiche-paginate.js';
import {
    buildMicrofichePlan,
    buildMicroficheRawPlan,
    splitMicroficheTexts,
} from '../src/core/microfiche-policy.js';
import {
    createMicrofichePageSource,
    hashMicroficheShape,
    selectSealedRegions,
} from '../src/core/microfiche-pages.js';
import { buildInjection } from '../src/core/memory-injection.js';
import { describeMicroficheBilling, estimateContextPreview } from '../src/core/token-budget.js';
import {
    expandMicrofichePromptChat,
    formatMicroficheMarker,
} from '../src/core/microfiche-transport.js';
import { makeRawChatSlice, installTestMicroficheFonts } from './test-helpers.js';

// Pagination, the split plan, and the page source seam live here: this suite
// pins page strings, split order, and marker expansion. It never compares PNG
// bytes; the fake renderer below is a deterministic placeholder.

beforeAll(() => {
    installTestMicroficheFonts();
});

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

function googleShape(overrides = {}) {
    return { ...resolveMicroficheShape(GEMINI_KNOBS), ...overrides };
}

function makeFakeRenderer() {
    function renderPage(text) {
        return { dataUrl: `data:fake:${text}`, text };
    }
    return { renderPage };
}

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

describe('microfiche region selection', () => {
    const sealed = {
        microfiche: { shape: {}, imageTexts: ['memory page'], rawTexts: [] },
        microficheRaw: { shape: {}, imageTexts: ['raw page'], rawTexts: [] },
    };

    it('always ships sealed memory and drops raw unless Old Chat Photos is on', () => {
        expect(selectSealedRegions(sealed, { microficheFrozenRawImages: false })).toEqual({
            microfiche: sealed.microfiche,
            microficheRaw: null,
        });
        expect(selectSealedRegions(sealed, { microficheFrozenRawImages: true })).toEqual({
            microfiche: sealed.microfiche,
            microficheRaw: sealed.microficheRaw,
        });
    });

    it('ships nothing before the writer seals', () => {
        expect(selectSealedRegions(null, {})).toEqual({ microfiche: null, microficheRaw: null });
    });
});

describe('microfiche frozen-raw plan', () => {
    const rawChat = makeRawChatSlice(9);
    const rawSettings = {
        ...GEMINI_KNOBS,
        memoryMode: 'microfiche',
        microficheGeometry: 'google',
        microficheKeepRaw: 0,
        microficheImageCap: 8,
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
        microficheFrozenRawImages: true,
    };

    it('images the oldest raw pages with empty memory layers', () => {
        const injection = buildInjection([], rawSettings, null, { rawTexts: rawChat });
        expect(injection.microfiche).toBeNull();
        expect(injection.microficheRaw).not.toBeNull();
        expect(injection.microficheRaw.imageTexts.length).toBeGreaterThan(0);
    });

    it('leaves the memory plan unchanged when frozen raw imaging is on', () => {
        const layers = [[{ text: 'word '.repeat(500) }]];
        const withoutRaw = buildInjection(layers, rawSettings);
        const withRaw = buildInjection(layers, rawSettings, null, { rawTexts: rawChat });
        expect(withRaw.microfiche).toEqual(withoutRaw.microfiche);
        expect(withRaw.microficheRaw).not.toBeNull();
    });

    it('keeps the page after the cap in rawTexts', () => {
        const settings = { ...rawSettings, microficheImageCap: 5 };
        const injection = buildInjection([], settings, null, { rawTexts: rawChat });
        const shape = injection.microficheRaw.shape;
        const pages = buildMicrofichePageTexts(rawChat, shape).imageTexts;
        expect(pages.length).toBeGreaterThan(5);
        expect(injection.microficheRaw.imageTexts).toEqual(pages.slice(0, 5));
        expect(injection.microficheRaw.rawTexts).toContain(pages[5]);
    });

    it('leaves the region off when the frozen-raw toggle is off', () => {
        const injection = buildInjection(
            [],
            { ...rawSettings, microficheFrozenRawImages: false },
            null,
            { rawTexts: rawChat },
        );
        expect(injection.microficheRaw).toBeNull();
    });

    it('images a short raw page when the cap has room', () => {
        const plan = buildMicroficheRawPlan(['short raw line'], rawSettings, {});
        expect(plan.imageTexts).toEqual(['short raw line']);
        expect(plan.rawTexts).toEqual([]);
    });

    it('bills raw image tokens from the one raw bucket', () => {
        const injection = buildInjection([], rawSettings, null, { rawTexts: rawChat });
        const images = injection.microficheRaw.imageTexts.length;
        const imageTokens = images * injection.microficheRaw.frameTokenEstimate;
        const billing = describeMicroficheBilling(injection, rawSettings);
        expect(billing.images).toBe(images);
        expect(billing.imageTokens).toBe(imageTokens);
        expect(billing.bucketAfterImages).toBe(36000 - imageTokens);
        const noImages = estimateContextPreview(rawSettings, null);
        const preview = estimateContextPreview(rawSettings, injection);
        expect(preview.rawChatMax).toBe(noImages.rawChatMax - imageTokens);
        expect(preview.mainMax).toBe(noImages.mainMax);
    });

    it('reconciles the raw cap against the shared raw bucket', () => {
        const settings = {
            ...GEMINI_KNOBS,
            memoryMode: 'microfiche',
            microficheGeometry: 'anthropic',
            microficheFont: '8x13',
            microficheCellHeight: 16,
            microficheFrameSize: 1568,
            microficheImageCap: 8,
            verbatimTokenBudget: 7000,
            queuedTokenBudget: 5000,
            microficheFrozenRawImages: true,
        };
        const slice = makeRawChatSlice(3);
        const plan = buildMicroficheRawPlan(slice, settings, {});
        const pages = buildMicrofichePageTexts(slice, plan.shape).imageTexts;
        expect(plan.effectiveCap).toBe(3);
        expect(plan.imageTexts).toEqual(pages.slice(0, 3));
        expect(plan.rawTexts).toEqual(pages.slice(3));
    });
});

describe('microfiche buildMicrofichePageTexts from settings', () => {
    const knobs = {
        ...GEMINI_KNOBS,
        microficheKeepRaw: 0,
        microficheImageCap: 8,
        microficheGeometry: 'google',
    };
    const tiny = { ...knobs, microficheFrameSize: 64 };
    const snippets = [
        'aaa bbb ccc ddd eee fff ggg hhh',
        'iii jjj kkk lll mmm nnn ooo ppp',
        'qqq rrr sss ttt uuu vvv www xxx',
        'yyy zzz aaa bbb ccc ddd eee fff',
        'ggg hhh iii jjj kkk lll mmm nnn',
        'ooo ppp qqq rrr sss ttt uuu vvv',
        'www xxx yyy zzz aaa bbb ccc ddd',
        'eee fff ggg hhh iii jjj kkk lll',
    ];

    it('caps image pages at the slider with unbounded host and preset budgets', () => {
        const plan = buildMicrofichePlan(snippets, tiny, {});
        const uncapped = buildMicrofichePageTexts(
            splitMicroficheTexts(snippets, 0).imageTexts,
            plan.shape,
        ).imageTexts;
        expect(uncapped.length).toBeGreaterThan(8);
        expect(plan.imageTexts).toEqual(uncapped.slice(0, 8));
        expect(plan.rawTexts.join('\n')).toContain(uncapped.slice(8).join('\n'));
    });

    it('takes the min of slider, host, and preset budgets with overflow as text', () => {
        const hostPlan = buildMicrofichePlan(snippets, tiny, { imageBudget: 1 });
        const hostUncapped = buildMicrofichePageTexts(
            splitMicroficheTexts(snippets, 0).imageTexts,
            hostPlan.shape,
        ).imageTexts;
        expect(hostPlan.imageTexts).toEqual(hostUncapped.slice(0, 1));
        expect(hostPlan.rawTexts.join('\n')).toContain(hostUncapped.slice(1).join('\n'));
        const anthropicKnobs = { ...tiny, microficheGeometry: 'anthropic', microficheImageCap: 80 };
        const anthropicPlan = buildMicrofichePlan(snippets, anthropicKnobs, {});
        const anthropicUncapped = buildMicrofichePageTexts(
            splitMicroficheTexts(snippets, 0).imageTexts,
            anthropicPlan.shape,
        ).imageTexts;
        expect(anthropicUncapped.length).toBeGreaterThan(5);
        expect(anthropicPlan.imageTexts).toEqual(anthropicUncapped.slice(0, 5));
        expect(anthropicPlan.rawTexts.join('\n')).toContain(anthropicUncapped.slice(5).join('\n'));
    });

    it('reads no preset budget for custom geometry', () => {
        const customKnobs = { ...tiny, microficheGeometry: 'custom', microficheImageCap: 2 };
        const plan = buildMicrofichePlan(snippets, customKnobs, {});
        const uncapped = buildMicrofichePageTexts(
            splitMicroficheTexts(snippets, 0).imageTexts,
            plan.shape,
        ).imageTexts;
        expect(plan.imageTexts).toEqual(uncapped.slice(0, 2));
        expect(plan.imageTexts.length).toBe(2);
    });
});

describe('microfiche buildMicrofichePlan page order', () => {
    it('orders overflow pages after the image pages and ignores the keep-raw setting', () => {
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
        const pages = buildMicrofichePageTexts(texts, plan.shape).imageTexts;
        expect(pages.length).toBeGreaterThan(2);
        expect(plan.imageTexts).toEqual(pages.slice(0, 2));
        expect(plan.rawTexts).toEqual(pages.slice(2));
    });
});

describe('microfiche buildMicrofichePageTexts', () => {
    it('emits no image payloads, only page strings', () => {
        const split = splitMicroficheTexts(['alpha one', 'beta two', 'gamma three'], 1);
        const result = buildMicrofichePageTexts(split.imageTexts, googleShape());
        expect(result.imageTexts.length).toBe(1);
        expect(typeof result.imageTexts[0]).toBe('string');
        expect(JSON.stringify(result)).not.toContain('data:image');
        expect(JSON.stringify(result)).not.toContain('base64');
    });

    it('yields no pages for whitespace-only input', () => {
        expect(buildMicrofichePageTexts(['   '], googleShape())).toEqual({
            imageTexts: [],
            rawTexts: [],
        });
    });

    it('dims stopwords after pagination when the shape asks for it', () => {
        const result = buildMicrofichePageTexts(
            ['the cat sat'],
            googleShape({ stopwordDim: true }),
        );
        expect(result.imageTexts[0]).toContain(`${DIM_ON}the${DIM_OFF}`);
    });

    it('keeps narrow-script letters printable instead of folding them to ?', () => {
        const shape = googleShape({ font: '8x13', cellWidth: 11, cellHeight: 16 });
        const result = buildMicrofichePageTexts(['Вова$$засмотрелся$$на$$ее'], shape);
        expect(result.imageTexts.length).toBe(1);
        expect(result.imageTexts[0]).toBe('Вова$$засмотрелся$$на$$ее');
        expect(result.imageTexts[0]).not.toMatch(/\?{3}/);
    });

    it('folds a wide CJK glyph to ? until the CJK font follow-up', () => {
        const result = buildMicrofichePageTexts(['界'], googleShape());
        expect(result.imageTexts).toEqual(['?']);
    });

    it('folds a narrow-script letter the shape font does not cover', () => {
        const result = buildMicrofichePageTexts(['Вова'], googleShape());
        expect(result.imageTexts).toEqual(['????']);
    });
});

describe('microfiche page split', () => {
    const shape = googleShape({ frameSize: 64 });

    it('breaks a page after the last period before the capacity edge', () => {
        const result = buildMicrofichePageTexts(['aa. bbb ccc ddd eee'], shape);
        expect(result.imageTexts).toEqual(['aa. ', 'bbb ccc ddd eee']);
        expect(result.rawTexts).toEqual([]);
    });

    it('breaks a page after the newline glyph between messages', () => {
        const result = buildMicrofichePageTexts(['aaaa bbbb cccc', 'dddd eeee ffff'], shape);
        expect(result.imageTexts).toEqual([`aaaa bbbb cccc${NEWLINE_GLYPH}`, 'dddd eeee ffff']);
    });

    it('hard-cuts at capacity when no period or newline fits', () => {
        const result = buildMicrofichePageTexts(['a'.repeat(40)], shape);
        expect(result.imageTexts.map((page) => page.length)).toEqual([16, 16, 8]);
    });

    it('lets one message span pages and share a page with the next', () => {
        const result = buildMicrofichePageTexts(['x'.repeat(20), 'yy'], shape);
        expect(result.imageTexts).toEqual(['x'.repeat(16), `xxxx${NEWLINE_GLYPH}yy`]);
    });
});

describe('microfiche hashMicroficheShape', () => {
    it('covers geometry keys only', () => {
        const shape = googleShape();
        expect(hashMicroficheShape(shape)).toBe(hashMicroficheShape(googleShape()));
        expect(hashMicroficheShape(shape)).not.toBe(
            hashMicroficheShape(googleShape({ frameSize: 1568 })),
        );
        expect(hashMicroficheShape(shape)).not.toBe(
            hashMicroficheShape(googleShape({ variant: 'sent' })),
        );
        expect(hashMicroficheShape({ ...shape, frameTokenEstimate: 999 })).toBe(
            hashMicroficheShape(shape),
        );
        expect(hashMicroficheShape({ ...shape, frameTokenEstimate: 3136, imageBudget: 5 })).toBe(
            hashMicroficheShape(shape),
        );
    });
});

describe('microfiche oldest-to-images proof', () => {
    it('expands oldest pages to images in order while the raw tail stays text', () => {
        const shape = googleShape();
        const snippets = ['alpha one', 'beta two', 'gamma three'];
        const split = splitMicroficheTexts(snippets, 1);
        expect(split).toEqual({
            imageTexts: ['alpha one', 'beta two'],
            rawTexts: ['gamma three'],
        });

        const built = buildMicrofichePageTexts(split.imageTexts, shape);
        expect(built.imageTexts.length).toBe(1);

        const { renderPage } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        source.update({
            plan: { shape, imageTexts: built.imageTexts },
            epoch: 0,
        });
        const pages = built.imageTexts.map((_, index) => source.readPage(index));
        expect(pages.length).toBeGreaterThan(0);

        const markers = pages.map((_, index) => formatMicroficheMarker(index)).join(' ');
        const chat = [{ role: 'user', content: `${markers} ${split.rawTexts.join(' ')}` }];
        const swapped = expandMicrofichePromptChat(chat, (index) => source.readPage(index));
        expect(swapped).toBe(pages.length);
        const content = chat[0].content;
        expect(Array.isArray(content)).toBe(true);
        const parts = Array.isArray(content) ? content : [];
        const imageParts = parts.filter((part) => part.type === 'image_url');
        expect(imageParts.map((part) => part.image_url.url)).toEqual(
            pages.map((page) => page.dataUrl),
        );
        const textParts = parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(' ');
        expect(textParts).toContain('gamma three');
        expect(textParts).not.toContain('alpha one');
        expect(textParts).not.toContain('beta two');
        expect(imageParts.length).toBe(pages.length);
    });
});
