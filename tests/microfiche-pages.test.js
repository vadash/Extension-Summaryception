import { describe, expect, it } from 'vitest';

import {
    buildMicrofichePageTexts,
    resolveMicroficheShape,
} from '../src/core/microfiche-paginate.js';
import { buildMicrofichePlan, splitMicroficheTexts } from '../src/core/microfiche-policy.js';
import {
    createMicrofichePageSource,
    hashMicroficheShape,
    renderMicrofichePages,
} from '../src/core/microfiche-pages.js';
import {
    expandMicrofichePromptChat,
    formatMicroficheMarker,
} from '../src/core/microfiche-transport.js';

// Legibility parity only: this suite pins structure and order (draw calls,
// chronology, layout). It never compares PNG bytes, and the fake dataUrls
// below are deterministic placeholders, never reference raster output.

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

function geminiShape(overrides = {}) {
    return { ...resolveMicroficheShape(GEMINI_KNOBS), ...overrides };
}

function makeFakeCanvas() {
    return {
        width: 0,
        height: 0,
        toDataURL(mime) {
            return `data:image/png;fake:${this.width}x${this.height}:${mime}`;
        },
    };
}

function makeFakeContext(calls, pageIndex) {
    const ctx = {
        fillStyle: '#000000',
        font: '',
        textBaseline: '',
        textAlign: '',
        fillText(ch, x, y) {
            calls.push({ type: 'fillText', ch, x, y, fillStyle: ctx.fillStyle, page: pageIndex });
        },
        fillRect(x, y, w, h) {
            calls.push({ type: 'fillRect', x, y, w, h, fillStyle: ctx.fillStyle, page: pageIndex });
        },
    };
    return ctx;
}

function makeFakeFactory() {
    const calls = [];
    const canvases = [];
    function canvasFactory(width, height) {
        const pageIndex = canvases.length;
        const canvas = makeFakeCanvas();
        canvas.width = width;
        canvas.height = height;
        const ctx = makeFakeContext(calls, pageIndex);
        canvas.toDataURL = (mime) => {
            calls.push({ type: 'toDataURL', mime, page: pageIndex });
            return `data:image/png;fake:page${pageIndex}:${canvas.width}x${canvas.height}`;
        };
        canvases.push({ canvas, ctx, width, height });
        return { canvas, ctx };
    }
    return { canvasFactory, calls, canvases };
}

describe('microfiche buildMicrofichePageTexts from settings', () => {
    const knobs = {
        ...GEMINI_KNOBS,
        microficheKeepRaw: 0,
        microficheImageCap: 8,
        microficheGeometry: 'gemini',
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
        const glmKnobs = { ...tiny, microficheGeometry: 'glm', microficheImageCap: 80 };
        const glmPlan = buildMicrofichePlan(snippets, glmKnobs, {});
        const glmUncapped = buildMicrofichePageTexts(
            splitMicroficheTexts(snippets, 0).imageTexts,
            glmPlan.shape,
        ).imageTexts;
        expect(glmUncapped.length).toBeGreaterThan(5);
        expect(glmPlan.imageTexts).toEqual(glmUncapped.slice(0, 5));
        expect(glmPlan.rawTexts.join('\n')).toContain(glmUncapped.slice(5).join('\n'));
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

describe('microfiche renderMicrofichePages', () => {
    it('keeps input order and calls toDataURL on the injected canvas', () => {
        const factory = makeFakeFactory();
        const pages = renderMicrofichePages(
            ['AAA first', 'BBB second'],
            geminiShape(),
            factory.canvasFactory,
        );
        expect(pages.map((page) => page.text)).toEqual(['AAA first', 'BBB second']);
        expect(factory.canvases.length).toBe(2);
        const dataCalls = factory.calls.filter((call) => call.type === 'toDataURL');
        expect(dataCalls.map((call) => call.mime)).toEqual(['image/png', 'image/png']);
        expect(dataCalls.map((call) => call.page)).toEqual([0, 1]);
        const textCalls = factory.calls.filter((call) => call.type === 'fillText');
        const firstPageLast = textCalls.map((call) => call.page).lastIndexOf(0);
        const secondPageFirst = textCalls.map((call) => call.page).indexOf(1);
        expect(firstPageLast).toBeLessThan(secondPageFirst);
        for (const page of pages) {
            expect(typeof page.dataUrl).toBe('string');
        }
    });

    it('reads pages back through the transport resolvePage signature', () => {
        const factory = makeFakeFactory();
        const source = createMicrofichePageSource({ canvasFactory: factory.canvasFactory });
        source.update({
            plan: { shape: geminiShape(), imageTexts: ['one', 'two'] },
            text: 'built injection text',
            epoch: 0,
        });
        expect(source.readPage(0).text).toBe('one');
        expect(source.readPage(1).text).toBe('two');
        expect(source.readPage(9)).toBe(undefined);
        expect(typeof source.readPage(0).dataUrl).toBe('string');
    });
});

describe('microfiche hashMicroficheShape', () => {
    it('covers geometry keys only', () => {
        const shape = geminiShape();
        expect(hashMicroficheShape(shape)).toBe(hashMicroficheShape(geminiShape()));
        expect(hashMicroficheShape(shape)).not.toBe(
            hashMicroficheShape(geminiShape({ frameSize: 1568 })),
        );
        expect(hashMicroficheShape(shape)).not.toBe(
            hashMicroficheShape(geminiShape({ variant: 'sent' })),
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
        const shape = geminiShape();
        const snippets = ['alpha one', 'beta two', 'gamma three'];
        const split = splitMicroficheTexts(snippets, 1);
        expect(split).toEqual({
            imageTexts: ['alpha one', 'beta two'],
            rawTexts: ['gamma three'],
        });

        const built = buildMicrofichePageTexts(split.imageTexts, shape);
        expect(built.imageTexts.length).toBe(1);

        const factory = makeFakeFactory();
        const pages = renderMicrofichePages(built.imageTexts, shape, factory.canvasFactory);
        expect(pages.length).toBeGreaterThan(0);
        const source = createMicrofichePageSource({
            canvasFactory: makeFakeFactory().canvasFactory,
        });
        source.update({
            plan: { shape, imageTexts: built.imageTexts },
            text: 'built injection text',
            epoch: 0,
        });

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
        expect(textParts.indexOf('alpha')).toBeLessThan(textParts.indexOf('beta'));
        expect(textParts).toContain('gamma three');
        expect(imageParts.length).toBe(pages.length);
    });
});

describe('microfiche full variant key set', () => {
    it('draws every reference font, ink, dim, column, repeat, and frame combination in order', () => {
        const texts = ['A one two three', 'B four five six'];
        let drawn = 0;
        for (const font of ['5x8', '8x8', '6x12', '8x13', 'silver']) {
            for (const variant of ['bw', 'sent']) {
                for (const stopwordDim of [false, true]) {
                    for (const columns of [1, 2]) {
                        for (const lineRepeat of [1, 2]) {
                            for (const frameSize of [1568, 2048]) {
                                const shape = geminiShape({
                                    font,
                                    variant,
                                    stopwordDim,
                                    columns,
                                    lineRepeat,
                                    frameSize,
                                });
                                const factory = makeFakeFactory();
                                const pages = renderMicrofichePages(
                                    texts,
                                    shape,
                                    factory.canvasFactory,
                                );
                                expect(pages.map((page) => page.text)).toEqual(texts);
                                const fills = factory.calls.filter(
                                    (call) => call.type === 'fillText',
                                );
                                expect(fills.length).toBeGreaterThan(0);
                                drawn += pages.length;
                            }
                        }
                    }
                }
            }
        }
        expect(drawn).toBe(2 * 5 * 2 * 2 * 2 * 2 * 2);
    });
});
