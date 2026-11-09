import { describe, expect, it } from 'vitest';

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

// One layout truth: the frame table, the cell rules, and the draw walk agree
// cell-for-cell. Appearance assertions pin the visible draw structure only;
// PNG bytes are never compared.

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
            font: '',
            textBaseline: '',
            fillText(ch, x, y) {
                calls.push({
                    type: 'fillText',
                    ch,
                    x,
                    y,
                    fillStyle: ctx.fillStyle,
                    page: pageIndex,
                });
            },
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

function fillTexts(factory) {
    return factory.calls.filter((call) => call.type === 'fillText');
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

    it('keeps silver geometry with wide cells off', () => {
        expect(usesWideCells(geminiShape({ font: 'silver' }))).toBe(false);
        expect(usesWideCells(geminiShape())).toBe(true);
        expect(frameGrid(geminiShape({ font: 'silver' }), 2048)).toEqual({
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

        const tallFactory = makeRecordingFactory();
        const tallText = `A${'.'.repeat(600)}`;
        const tall = drawMicrofichePage(tallText, geminiShape(), tallFactory.canvasFactory);
        expect(tall.height).toBeGreaterThan(64);
    });

    it('sets the monospace font and top baseline from the cell pitch', () => {
        const shape = geminiShape();
        const factory = makeRecordingFactory();
        drawMicrofichePage('Hi', shape, factory.canvasFactory);
        const { ctx } = factory.canvases[0];
        expect(ctx.font).toBe(
            `${Math.max(1, Math.min(shape.cellHeight, shape.cellWidth / 0.6))}px monospace`,
        );
        expect(ctx.textBaseline).toBe('top');
    });

    it('places every glyph at its grid x and row y', () => {
        const shape = geminiShape({ frameSize: 64 });
        const factory = makeRecordingFactory();
        drawMicrofichePage('abcdefghij', shape, factory.canvasFactory);
        expect(fillTexts(factory).map(({ ch, x, y }) => ({ ch, x, y }))).toEqual([
            { ch: 'a', x: 0, y: 0 },
            { ch: 'b', x: 8, y: 0 },
            { ch: 'c', x: 16, y: 0 },
            { ch: 'd', x: 24, y: 0 },
            { ch: 'e', x: 32, y: 0 },
            { ch: 'f', x: 40, y: 0 },
            { ch: 'g', x: 48, y: 0 },
            { ch: 'h', x: 56, y: 0 },
            { ch: 'i', x: 0, y: 22 },
            { ch: 'j', x: 8, y: 22 },
        ]);
    });

    it('cycles sentence hues only for the sent variant', () => {
        const text = 'Hello world. Again here.';
        const bwFactory = makeRecordingFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'bw' }), bwFactory.canvasFactory);
        const bwInks = new Set(fillTexts(bwFactory).map((call) => call.fillStyle));
        expect(bwInks.size).toBe(1);

        const sentFactory = makeRecordingFactory();
        drawMicrofichePage(text, geminiShape({ variant: 'sent' }), sentFactory.canvasFactory);
        const sentInks = new Set(fillTexts(sentFactory).map((call) => call.fillStyle));
        expect(sentInks.size).toBeGreaterThan(1);
    });

    it('prints dim spans in dim ink', () => {
        const factory = makeRecordingFactory();
        drawMicrofichePage(`${DIM_ON}the${DIM_OFF} cat`, geminiShape(), factory.canvasFactory);
        const fills = fillTexts(factory);
        expect(fills.filter((call) => call.fillStyle === '#808080').map((call) => call.ch)).toEqual(
            ['t', 'h', 'e'],
        );
        expect(fills.some((call) => call.fillStyle !== '#808080')).toBe(true);
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
        expect(fillTexts(factory).some((call) => call.x >= secondColumnX)).toBe(true);
    });
});
