import { beforeAll, describe, expect, it } from 'vitest';

import { renderMicrofichePages } from '../src/core/microfiche-pages.js';
import { resolveMicroficheShape } from '../src/core/microfiche-paginate.js';
import { installTestMicroficheFonts } from './test-helpers.js';

// Legibility parity only: this suite pins blit calls, page order, and canvas
// capture. It never compares PNG bytes, and the fake dataUrls below are
// deterministic placeholders, never reference raster output.

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
        fillRect(x, y, w, h) {
            calls.push({ type: 'fillRect', x, y, w, h, fillStyle: ctx.fillStyle, page: pageIndex });
        },
    };
    return ctx;
}

/**
 * @param {{ calls: Array<{ type: string, x?: number, y?: number, w?: number, h?: number, fillStyle?: string, page?: number }> }} factory
 * @returns {Array<{ x: number, y: number, fillStyle: string, page: number }>} One-pixel glyph blits.
 */
function glyphPixels(factory) {
    return factory.calls
        .filter((call) => call.type === 'fillRect' && call.w === 1 && call.h === 1)
        .map(
            (call) =>
                /** @type {{ x: number, y: number, fillStyle: string, page: number }} */ (call),
        );
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

describe('microfiche resolveMicroficheShape', () => {
    it('reads only the explicit render knobs', () => {
        expect(resolveMicroficheShape(GEMINI_KNOBS)).toEqual({
            font: '8x8',
            cellWidth: 8,
            cellHeight: 22,
            stretch: false,
            variant: 'bw',
            stopwordDim: false,
            columns: 1,
            lineRepeat: 1,
            frameSize: 2048,
        });
    });

    it('ignores preset selectors, caps, and keep-raw counts', () => {
        const shape = resolveMicroficheShape({
            ...GEMINI_KNOBS,
            microficheGeometry: 'glm',
            microficheModelName: 'some-model',
            microficheKeepRaw: 0,
            microficheImageCap: 0,
        });
        expect(shape).toEqual(resolveMicroficheShape(GEMINI_KNOBS));
    });

    it('passes custom knob values through untouched', () => {
        const shape = resolveMicroficheShape({
            microficheFont: '8x13',
            microficheCellWidth: 11,
            microficheCellHeight: 16,
            microficheStretch: false,
            microficheVariant: 'sent',
            microficheStopwordDim: true,
            microficheColumns: 2,
            microficheLineRepeat: 2,
            microficheFrameSize: 1568,
        });
        expect(shape).toEqual({
            font: '8x13',
            cellWidth: 11,
            cellHeight: 16,
            stretch: false,
            variant: 'sent',
            stopwordDim: true,
            columns: 2,
            lineRepeat: 2,
            frameSize: 1568,
        });
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
        const glyphCalls = glyphPixels(factory);
        const firstPageLast = glyphCalls.map((call) => call.page).lastIndexOf(0);
        const secondPageFirst = glyphCalls.map((call) => call.page).indexOf(1);
        expect(firstPageLast).toBeGreaterThan(-1);
        expect(firstPageLast).toBeLessThan(secondPageFirst);
        for (const page of pages) {
            expect(typeof page.dataUrl).toBe('string');
        }
    });

    it('draws stored silver settings from a loaded bitmap instead of blank frames', () => {
        const factory = makeFakeFactory();
        const pages = renderMicrofichePages(
            ['Latin corpus renders'],
            geminiShape({ font: 'silver' }),
            factory.canvasFactory,
        );
        expect(pages.map((page) => page.text)).toEqual(['Latin corpus renders']);
        expect(glyphPixels(factory).length).toBeGreaterThan(0);
    });

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
                                const fills = glyphPixels(factory);
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

describe('microfiche renderer host freedom', () => {
    it('runs with no document or canvas in scope', () => {
        expect(typeof document).toBe('undefined');
        expect(typeof window).toBe('undefined');
        expect(typeof HTMLCanvasElement).toBe('undefined');
    });
});
