import { describe, expect, it } from 'vitest';

import { DIM_OFF, DIM_ON } from '../src/core/microfiche-normalize.js';
import {
    buildMicrofichePageTexts,
    geometry,
    resolveMicroficheEffectiveCap,
    resolveMicroficheShape,
} from '../src/core/microfiche-paginate.js';
import { drawMicrofichePage } from '../src/core/microfiche-render.js';
import {
    createMicrofichePageReader,
    hashMicroficheShape,
    renderMicrofichePages,
    splitMicroficheSnippets,
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

describe('microfiche splitMicroficheSnippets', () => {
    it('sends the oldest outside the verbatim window to images, newest-K stay text', () => {
        expect(splitMicroficheSnippets(['a', 'b', 'c', 'd'], 2)).toEqual({
            imageSource: ['a', 'b'],
            rawTail: ['c', 'd'],
        });
    });

    it('sends everything to images when keepRaw is 0', () => {
        expect(splitMicroficheSnippets(['a', 'b'], 0)).toEqual({
            imageSource: ['a', 'b'],
            rawTail: [],
        });
    });

    it('keeps everything raw when keepRaw covers the input', () => {
        expect(splitMicroficheSnippets(['a', 'b'], 2)).toEqual({
            imageSource: [],
            rawTail: ['a', 'b'],
        });
        expect(splitMicroficheSnippets(['a', 'b'], 9)).toEqual({
            imageSource: [],
            rawTail: ['a', 'b'],
        });
    });
});

describe('microfiche resolveMicroficheEffectiveCap', () => {
    it('takes the smallest finite non-negative budget', () => {
        expect(resolveMicroficheEffectiveCap(8, undefined, 200)).toBe(8);
        expect(resolveMicroficheEffectiveCap(8, 3, 200)).toBe(3);
        expect(resolveMicroficheEffectiveCap(8, 10, 5)).toBe(5);
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

describe('microfiche splitMicroficheSnippets with an effective cap', () => {
    it('caps image pages and keeps the overflow as raw text in order', () => {
        expect(splitMicroficheSnippets(['a', 'b', 'c', 'd'], 0, 2)).toEqual({
            imageSource: ['a', 'b'],
            rawTail: ['c', 'd'],
        });
        expect(splitMicroficheSnippets(['a', 'b', 'c', 'd'], 1, 1)).toEqual({
            imageSource: ['a'],
            rawTail: ['b', 'c', 'd'],
        });
    });

    it('sends everything raw when the cap is zero', () => {
        expect(splitMicroficheSnippets(['a', 'b'], 0, 0)).toEqual({
            imageSource: [],
            rawTail: ['a', 'b'],
        });
    });

    it('behaves as before when the cap is absent', () => {
        expect(splitMicroficheSnippets(['a', 'b', 'c', 'd'], 2)).toEqual({
            imageSource: ['a', 'b'],
            rawTail: ['c', 'd'],
        });
    });
});

describe('microfiche drawMicrofichePage', () => {
    it('draws through the injected factory with a hugging height and a 64px floor', () => {
        const shortFactory = makeFakeFactory();
        const short = drawMicrofichePage('Hi', geminiShape(), shortFactory.canvasFactory);
        expect(short.width).toBe(2048);
        expect(short.height).toBe(64);
        expect(shortFactory.canvases[0].width).toBe(2048);
        expect(shortFactory.canvases[0].height).toBe(64);
        expect(typeof document).toBe('undefined');

        const tallFactory = makeFakeFactory();
        const tallText = `A${'.'.repeat(600)}`;
        const tall = drawMicrofichePage(tallText, geminiShape(), tallFactory.canvasFactory);
        expect(tall.height).toBeGreaterThan(64);
    });

    it('cycles sentence hues only for the sent variant', () => {
        const text = 'Hello world. Again here.';
        const bwFactory = makeFakeFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'bw' }), bwFactory.canvasFactory);
        const bwInks = new Set(
            bwFactory.calls
                .filter((call) => call.type === 'fillText')
                .map((call) => call.fillStyle),
        );
        expect(bwInks.size).toBe(1);

        const sentFactory = makeFakeFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'sent' }), sentFactory.canvasFactory);
        const sentInks = new Set(
            sentFactory.calls
                .filter((call) => call.type === 'fillText')
                .map((call) => call.fillStyle),
        );
        expect(sentInks.size).toBeGreaterThan(1);
    });

    it('prints dim spans in dim ink', () => {
        const factory = makeFakeFactory();
        drawMicrofichePage(`${DIM_ON}the${DIM_OFF} cat`, geminiShape(), factory.canvasFactory);
        const fills = factory.calls.filter((call) => call.type === 'fillText');
        const dimFills = fills.filter((call) => call.fillStyle === '#808080');
        expect(dimFills.map((call) => call.ch)).toEqual(['t', 'h', 'e']);
        expect(fills.some((call) => call.fillStyle !== '#808080')).toBe(true);
    });

    it('paints a highlight band only when lines repeat', () => {
        const onceFactory = makeFakeFactory();
        drawMicrofichePage('Hello', geminiShape({ lineRepeat: 1 }), onceFactory.canvasFactory);
        expect(
            onceFactory.calls.some(
                (call) => call.type === 'fillRect' && call.fillStyle === '#fff7c2',
            ),
        ).toBe(false);

        const repeatFactory = makeFakeFactory();
        drawMicrofichePage('Hello', geminiShape({ lineRepeat: 2 }), repeatFactory.canvasFactory);
        expect(
            repeatFactory.calls.some(
                (call) => call.type === 'fillRect' && call.fillStyle === '#fff7c2',
            ),
        ).toBe(true);
    });

    it('offsets the second newspaper column past the gutter', () => {
        const shape = geminiShape({ columns: 2 });
        const geo = geometry(shape, shape.frameSize);
        const secondColumnX = (geo.cols + 3) * shape.cellWidth;
        const lines = [];
        for (let index = 0; index < geo.rows + 2; index += 1) {
            lines.push(`w${index}`);
        }
        const factory = makeFakeFactory();
        drawMicrofichePage(lines.join('\n'), shape, factory.canvasFactory);
        const inked = factory.calls.filter((call) => call.type === 'fillText');
        expect(inked.some((call) => call.x >= secondColumnX)).toBe(true);
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
        const pages = renderMicrofichePages(['one', 'two'], geminiShape(), factory.canvasFactory);
        const reader = createMicrofichePageReader(pages);
        expect(reader(0)).toBe(pages[0]);
        expect(reader(1)).toBe(pages[1]);
        expect(reader(9)).toBe(undefined);
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
        const split = splitMicroficheSnippets(snippets, 1);
        expect(split).toEqual({ imageSource: ['alpha one', 'beta two'], rawTail: ['gamma three'] });

        const built = buildMicrofichePageTexts(snippets, shape, 1);
        expect(built.rawTexts).toEqual(['gamma three']);

        const factory = makeFakeFactory();
        const pages = renderMicrofichePages(built.imageTexts, shape, factory.canvasFactory);
        expect(pages.length).toBeGreaterThan(0);
        const reader = createMicrofichePageReader(pages);

        const markers = pages.map((_, index) => formatMicroficheMarker(index)).join(' ');
        const chat = [{ role: 'user', content: `${markers} ${built.rawTexts.join(' ')}` }];
        const swapped = expandMicrofichePromptChat(chat, reader);
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
