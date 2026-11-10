import { beforeAll, describe, expect, it } from 'vitest';

import { DIM_OFF, DIM_ON, normalize } from '../src/core/microfiche-normalize.js';
import {
    DOC_GUTTER,
    charCells,
    frameGrid,
    nextCell,
    usesWideCells,
} from '../src/core/microfiche-geometry.js';
import {
    buildMicrofichePageTexts,
    resolveMicroficheShape,
} from '../src/core/microfiche-paginate.js';
import { drawMicrofichePage } from '../src/core/microfiche-render.js';
import { installTestMicroficheFonts } from './test-helpers.js';

// One layout truth: the frame table, the cell rules, and the draw walk agree
// cell-for-cell. Appearance assertions pin the visible blit structure only;
// PNG bytes are never compared.

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

function stripDimMarkers(text) {
    return String(text).split(DIM_ON).join('').split(DIM_OFF).join('');
}

function makeRecordingFactory() {
    const calls = [];
    const canvases = [];
    function canvasFactory(width, height) {
        const pageIndex = canvases.length;
        const canvas = {
            width,
            height,
            toDataURL: (mime) => `data:image/png;fake:${pageIndex}:${mime}`,
        };
        const ctx = {
            fillStyle: '#000000',
            fillRect(x, y, w, h) {
                calls.push({
                    type: 'fillRect',
                    x,
                    y,
                    w,
                    h,
                    fillStyle: ctx.fillStyle,
                    page: pageIndex,
                });
            },
        };
        canvases.push({ canvas, ctx, width, height });
        return { canvas, ctx };
    }
    return { canvasFactory, calls, canvases };
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

const EDGE_CORPUS = [
    'abcDEFghiJKLmnoPQR',
    'abcdefg界hijklmno界',
    '界界界abc界界',
    `pre${DIM_ON}dim span inside${DIM_OFF}post`,
    'first line\n\nsecond line\r\nthird line',
    '0123456789 9876543210',
    '尾末界wide象形字 more ascii',
    `x${DIM_ON}y${DIM_OFF}z and ${DIM_ON}late dim${DIM_OFF}`,
].join('\n');

const CONTIGUOUS_CORPUS = `abc界def${DIM_ON}dim${DIM_OFF}ghi${'界'.repeat(3)}jklmno0123456789`;

describe('microfiche text geometry', () => {
    it('computes the one-column frame grid', () => {
        expect(frameGrid(geminiShape(), 2048)).toEqual({
            cols: 256,
            rows: 93,
            capacity: 23808,
            repeat: 1,
        });
    });

    it('splits two columns around the shared gutter', () => {
        expect(frameGrid(geminiShape({ columns: 2 }), 2048)).toEqual({
            cols: 126,
            rows: 93,
            capacity: 23436,
            repeat: 1,
        });
    });

    it('divides rows by the floored line repeat', () => {
        expect(frameGrid(geminiShape({ lineRepeat: 2 }), 2048)).toEqual({
            cols: 256,
            rows: 46,
            capacity: 11776,
            repeat: 2,
        });
    });

    it('counts wide glyphs across two cells for every bitmap font', () => {
        for (const font of ['5x8', '8x8', '6x12', '8x13']) {
            expect(usesWideCells(geminiShape({ font }))).toBe(true);
        }
        expect(frameGrid(geminiShape({ font: '8x13' }), 2048)).toEqual({
            cols: 256,
            rows: 93,
            capacity: 23808,
            repeat: 1,
        });
    });

    it('clamps a degenerate frame to a one-cell grid', () => {
        expect(frameGrid(geminiShape(), 0)).toEqual({
            cols: 1,
            rows: 1,
            capacity: 1,
            repeat: 1,
        });
        expect(frameGrid(geminiShape({ columns: 2 }), 0)).toEqual({
            cols: 1,
            rows: 1,
            capacity: 2,
            repeat: 1,
        });
    });

    it('counts narrow, wide, and zero-width characters', () => {
        expect(charCells('a', true)).toBe(1);
        expect(charCells('界', true)).toBe(2);
        expect(charCells('界', false)).toBe(1);
        expect(charCells(DIM_ON, true)).toBe(0);
        expect(charCells(DIM_OFF, true)).toBe(0);
    });

    it('pads a wide glyph off a row edge in grids and newspaper columns', () => {
        expect(nextCell(4, 2, 6, false)).toBe(4);
        expect(nextCell(5, 2, 6, false)).toBe(6);
        expect(nextCell(5, 1, 6, false)).toBe(5);
        expect(nextCell(5, 2, 1, false)).toBe(5);
        expect(nextCell(4, 2, 6, true)).toBe(4);
        expect(nextCell(5, 2, 6, true)).toBe(6);
    });
});

function assertCapacityMatchesDraw(shape, corpus) {
    const normalized = normalize(corpus, { font: shape.font });
    const result = buildMicrofichePageTexts([corpus], shape);
    expect(result.imageTexts.length).toBeGreaterThan(0);

    const geo = frameGrid(shape);
    const wideCells = usesWideCells(shape);
    const columnOffset = (geo.cols + DOC_GUTTER) * shape.cellWidth;
    const lastColumn = shape.columns === 2 ? 1 : 0;

    for (const pageText of result.imageTexts) {
        const glyphText = stripDimMarkers(pageText).split('\n').join('');
        const factory = makeRecordingFactory();
        const drawn = drawMicrofichePage(pageText, shape, factory.canvasFactory);

        expect(drawn.cells.map((cell) => cell.ch).join('')).toBe(glyphText);
        const expectedCells = [...glyphText].reduce((sum, ch) => sum + charCells(ch, wideCells), 0);
        expect(drawn.cells.length).toBe(expectedCells);

        for (const cell of drawn.cells) {
            const units = charCells(cell.ch, wideCells);
            const column = Math.floor(cell.x / columnOffset);
            const col = Math.round((cell.x - column * columnOffset) / shape.cellWidth);
            expect(column).toBeGreaterThanOrEqual(0);
            expect(column).toBeLessThanOrEqual(lastColumn);
            expect(col).toBeGreaterThanOrEqual(0);
            expect(col + units).toBeLessThanOrEqual(geo.cols);
            expect(cell.row).toBeGreaterThanOrEqual(0);
            expect(cell.row).toBeLessThan(geo.rows);
        }
    }

    return { normalized, result, geo };
}

describe('microfiche capacity and draw parity', () => {
    it('agrees cell-for-cell in a one-column grid', () => {
        const shape = geminiShape({ frameSize: 64 });
        assertCapacityMatchesDraw(shape, EDGE_CORPUS);
    });

    it('agrees cell-for-cell in two newspaper columns', () => {
        const shape = geminiShape({ columns: 2, frameSize: 64 });
        const { geo } = assertCapacityMatchesDraw(shape, EDGE_CORPUS);
        const secondColumnX = (geo.cols + DOC_GUTTER) * shape.cellWidth;
        const result = buildMicrofichePageTexts([EDGE_CORPUS], shape);
        const xs = [];
        for (const pageText of result.imageTexts) {
            const factory = makeRecordingFactory();
            const drawn = drawMicrofichePage(pageText, shape, factory.canvasFactory);
            for (const cell of drawn.cells) {
                if (cell.x >= secondColumnX) {
                    xs.push(cell.x);
                }
            }
        }
        expect(xs.length).toBeGreaterThan(0);
        expect(Math.min(...xs)).toBe(secondColumnX);
    });

    it('reproduces the normalized input when pages join', () => {
        for (const columns of [1, 2]) {
            const shape = geminiShape({ columns, frameSize: 64 });
            const { normalized, result } = assertCapacityMatchesDraw(shape, CONTIGUOUS_CORPUS);
            expect(stripDimMarkers(result.imageTexts.join('').split('\n').join(''))).toBe(
                stripDimMarkers(normalized),
            );
        }
    });
});

describe('microfiche draw appearance', () => {
    it('draws through the injected factory with a hugging height and a 64px floor', () => {
        const shortFactory = makeRecordingFactory();
        const short = drawMicrofichePage('Hi', geminiShape(), shortFactory.canvasFactory);
        expect(short.width).toBe(2048);
        expect(short.height).toBe(64);
        expect(shortFactory.canvases[0].width).toBe(2048);
        expect(shortFactory.canvases[0].height).toBe(64);
        expect(typeof document).toBe('undefined');

        const tallFactory = makeRecordingFactory();
        const tallText = `A${'.'.repeat(600)}`;
        const tall = drawMicrofichePage(tallText, geminiShape(), tallFactory.canvasFactory);
        expect(tall.height).toBeGreaterThan(64);
    });

    it('blits natural-size glyph bits at the font ascent from the cell top', () => {
        // 5x8 'a' BITMAP rows 00 00 00 70 90 90 70 00, ascent 7, height 8,
        // yOffset -1, so the glyph top lands on the cell top and row 3 prints
        // at y 3 in black ink.
        const shape = geminiShape({
            font: '5x8',
            cellWidth: 5,
            cellHeight: 8,
            frameSize: 64,
        });
        const factory = makeRecordingFactory();
        const drawn = drawMicrofichePage('a', shape, factory.canvasFactory);
        expect(drawn.cells.map((cell) => cell.ch)).toEqual(['a']);
        const pixels = glyphPixels(factory);
        expect(pixels.map(({ x, y }) => ({ x, y }))).toEqual([
            { x: 1, y: 3 },
            { x: 2, y: 3 },
            { x: 3, y: 3 },
            { x: 0, y: 4 },
            { x: 3, y: 4 },
            { x: 0, y: 5 },
            { x: 3, y: 5 },
            { x: 1, y: 6 },
            { x: 2, y: 6 },
            { x: 3, y: 6 },
        ]);
        expect(new Set(pixels.map((pixel) => pixel.fillStyle))).toEqual(new Set(['#000000']));
    });

    it('keeps natural size and pads below the baseline on a taller cell', () => {
        const shape = geminiShape({ font: '8x13', cellWidth: 11, cellHeight: 16, frameSize: 64 });
        const factory = makeRecordingFactory();
        drawMicrofichePage('A', shape, factory.canvasFactory);
        const pixels = glyphPixels(factory);
        expect(new Set(pixels.map((pixel) => pixel.y))).toEqual(
            new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]),
        );
        expect(Math.max(...pixels.map((pixel) => pixel.x))).toBe(6);
        expect(pixels.every((pixel) => pixel.x <= 7)).toBe(true);
    });

    it('blits the worked-example Cyrillic page from 8x13 bits', () => {
        const shape = geminiShape({ font: '8x13', cellWidth: 11, cellHeight: 16, frameSize: 1568 });
        const source = 'Вова$$засмотрелся$$на$$ее';
        const result = buildMicrofichePageTexts([source], shape);
        expect(result.imageTexts).toEqual([source]);

        const factory = makeRecordingFactory();
        const drawn = drawMicrofichePage(result.imageTexts[0], shape, factory.canvasFactory);
        expect(drawn.cells.map((cell) => cell.ch).join('')).toBe(source);
        const pixels = glyphPixels(factory);
        expect(pixels.length).toBeGreaterThan(0);
        const maxX = Math.max(...pixels.map((pixel) => pixel.x));
        expect(maxX).toBeLessThan(shape.frameSize);
        expect(factory.calls.some((call) => call.type === 'fillText')).toBe(false);
    });

    it('paints a full-block cell as one solid cell rect', () => {
        const shape = geminiShape({ frameSize: 64, cellWidth: 8, cellHeight: 22 });
        const factory = makeRecordingFactory();
        drawMicrofichePage('█', shape, factory.canvasFactory);
        expect(
            factory.calls.filter(
                (call) => call.type === 'fillRect' && call.fillStyle === '#000000',
            ),
        ).toEqual([{ type: 'fillRect', x: 0, y: 0, w: 8, h: 22, fillStyle: '#000000', page: 0 }]);
    });

    it('skips a cell whose code point has no glyph in the shape font', () => {
        const shape = geminiShape({ font: '8x13', cellWidth: 11, cellHeight: 16, frameSize: 64 });
        const factory = makeRecordingFactory();
        const drawn = drawMicrofichePage('界', shape, factory.canvasFactory);
        expect(drawn.cells.map((cell) => cell.ch)).toEqual(['界']);
        expect(glyphPixels(factory)).toEqual([]);
    });

    it('places every glyph at its grid x and row y', () => {
        const shape = geminiShape({ frameSize: 64 });
        const factory = makeRecordingFactory();
        drawMicrofichePage('abcdefghij', shape, factory.canvasFactory);
        const pixels = glyphPixels(factory);
        const firstRow = new Set(
            pixels.filter((pixel) => pixel.y < 22).map((pixel) => Math.floor(pixel.x / 8)),
        );
        const secondRow = new Set(
            pixels.filter((pixel) => pixel.y >= 22).map((pixel) => Math.floor(pixel.x / 8)),
        );
        expect(firstRow).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
        expect(secondRow).toEqual(new Set([0, 1]));
    });

    it('cycles sentence hues only for the sent variant', () => {
        const text = 'Hello world. Again here.';
        const bwFactory = makeRecordingFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'bw' }), bwFactory.canvasFactory);
        const bwInks = new Set(glyphPixels(bwFactory).map((call) => call.fillStyle));
        expect(bwInks.size).toBe(1);

        const sentFactory = makeRecordingFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'sent' }), sentFactory.canvasFactory);
        const sentInks = new Set(glyphPixels(sentFactory).map((call) => call.fillStyle));
        expect(sentInks.size).toBeGreaterThan(1);
    });

    it('prints dim spans in dim ink', () => {
        // Cells: t 0, h 8, e 16, space 24, c 32, a 40, t 48.
        const factory = makeRecordingFactory();
        drawMicrofichePage(`${DIM_ON}the${DIM_OFF} cat`, geminiShape(), factory.canvasFactory);
        const pixels = glyphPixels(factory);
        const dim = pixels.filter((pixel) => pixel.fillStyle === '#808080');
        expect(dim.length).toBeGreaterThan(0);
        expect(dim.every((pixel) => pixel.x < 24)).toBe(true);
        const bright = pixels.filter((pixel) => pixel.fillStyle !== '#808080');
        expect(bright.length).toBeGreaterThan(0);
        expect(bright.every((pixel) => pixel.x >= 32)).toBe(true);
    });

    it('paints a highlight band only when lines repeat', () => {
        const onceFactory = makeRecordingFactory();
        drawMicrofichePage('Hello', geminiShape({ lineRepeat: 1 }), onceFactory.canvasFactory);
        expect(
            onceFactory.calls.some(
                (call) => call.type === 'fillRect' && call.fillStyle === '#fff7c2',
            ),
        ).toBe(false);

        const repeatFactory = makeRecordingFactory();
        const repeatShape = geminiShape({ lineRepeat: 2, frameSize: 64 });
        drawMicrofichePage('Hello', repeatShape, repeatFactory.canvasFactory);
        const bands = repeatFactory.calls.filter(
            (call) => call.type === 'fillRect' && call.fillStyle === '#fff7c2',
        );
        expect(bands).toEqual([
            { type: 'fillRect', x: 0, y: 22, w: 64, h: 22, fillStyle: '#fff7c2', page: 0 },
        ]);
    });

    it('offsets the second newspaper column past the gutter', () => {
        const shape = geminiShape({ columns: 2, frameSize: 64 });
        const geo = frameGrid(shape);
        const secondColumnX = (geo.cols + DOC_GUTTER) * shape.cellWidth;
        const lines = [];
        for (let index = 0; index < geo.rows + 2; index += 1) {
            lines.push(`w${index}`);
        }
        const factory = makeRecordingFactory();
        drawMicrofichePage(lines.join('\n'), shape, factory.canvasFactory);
        expect(glyphPixels(factory).some((call) => call.x >= secondColumnX)).toBe(true);
    });
});
