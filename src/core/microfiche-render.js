// Microfiche Canvas2D renderer: pure grid layout, host-free raster seeding.
// Same state machine as the native frame printer (ported ideas only): one
// layout walk feeds both the height measure and the painter, so capacity math
// and drawing cannot disagree. Row-major grid or two newspaper columns.

import { DIM_OFF, DIM_ON } from './microfiche-normalize.js';
import { getMicroficheFont } from './microfiche-font-cache.js';
import {
    DOC_GUTTER,
    charCells,
    frameGrid,
    nextCell,
    usesWideCells,
} from './microfiche-geometry.js';

// Newline runs folded to one full-ink cell by the slice-1 normalizer.
const FULL_BLOCK = '█';

// Six dark sentence hues for the sent variant (values from the native indexed
// palette: HLS l=0.22 s=0.95, h in {0, .08, .3, .5, .62, .78}).
const SENTENCE_HUES = ['#6d0202', '#6d3502', '#186d02', '#026d6d', '#02206d', '#4b026d'];
const DIM_INK = '#808080';
const BLACK_INK = '#000000';
const REPEAT_BAND = '#fff7c2';

// Vision processors reject tiny frames, so short pages pad to this height.
const MIN_FRAME_HEIGHT = 64;

/**
 * @param {string} ch - One Unicode character.
 * @param {string | undefined} next - Following character, if any.
 * @param {boolean} doc - Whether newspaper columns also end sentences on newline.
 * @returns {boolean} True when the terminator ends a sentence here.
 */
function endsSentence(ch, next, doc) {
    if (ch !== '.' && ch !== '!' && ch !== '?') {
        return false;
    }
    return next === undefined || next === ' ' || next === FULL_BLOCK || (doc && next === '\n');
}

/**
 * @typedef {object} MicroficheLaidCell
 * @property {string} ch - Character to print in this cell.
 * @property {string} ink - CSS ink for the glyph.
 * @property {number} x - Pixel x origin of the cell.
 * @property {number} row - Text row band the glyph prints on.
 */

/**
 * @typedef {object} MicroficheDrawnPage
 * @property {number} width - Canvas width in pixels.
 * @property {number} height - Canvas height in pixels.
 * @property {MicroficheLaidCell[]} cells - Laid-out cells in draw order.
 */

/**
 * @typedef {object} MicroficheLayout
 * @property {MicroficheLaidCell[]} cells - Laid-out cells in draw order.
 * @property {boolean} doc - Whether newspaper columns split the grid.
 * @property {boolean} wideCells - Whether wide glyphs span two cells.
 * @property {boolean} blackInk - Whether the shape prints plain black ink.
 * @property {number} cols - Printable cells per row (per column for docs).
 * @property {number} rows - Printable text lines per frame.
 * @property {number} cellWidth - Target cell advance in pixels.
 * @property {boolean} dim - Whether dim ink is active.
 * @property {number} sentence - Sentence hue index.
 * @property {number} cursor - Next cell index.
 * @property {number} line - Current doc line.
 * @property {string} [next] - Following character, if any.
 */
/**
 * Resolve the ink for one glyph before it advances the sentence count.
 * @param {MicroficheLayout} layout - Mutable layout walk.
 * @param {string} ch - Current character.
 * @returns {string} CSS ink for the glyph.
 */
function takeInk(layout, ch) {
    const ink = layout.dim
        ? DIM_INK
        : layout.blackInk
          ? BLACK_INK
          : (SENTENCE_HUES[layout.sentence % SENTENCE_HUES.length] ?? BLACK_INK);
    if (endsSentence(ch, layout.next, layout.doc)) {
        layout.sentence += 1;
    }
    return ink;
}

/**
 * Place one glyph: row-major grids pad wide glyphs off row edges and stop
 * at capacity; newspaper columns clip past the column width instead.
 * @param {MicroficheLayout} layout - Mutable layout walk.
 * @param {string} ch - Character to place.
 * @param {string} ink - CSS ink for the glyph.
 * @returns {boolean} False when the grid is full.
 */
function placeCell(layout, ch, ink) {
    const units = charCells(ch, layout.wideCells);
    const cell = nextCell(layout.cursor, units, layout.cols, layout.doc);
    layout.cursor = cell + units;
    if (layout.doc) {
        if (layout.cursor > layout.cols) {
            return true;
        }
        const column = Math.floor(layout.line / layout.rows);
        const row = layout.line - column * layout.rows;
        layout.cells.push({
            ch,
            ink,
            x: (column * (layout.cols + DOC_GUTTER) + cell) * layout.cellWidth,
            row,
        });
        return true;
    }
    if (cell >= layout.cols * layout.rows) {
        return false;
    }
    const row = Math.floor(cell / layout.cols);
    layout.cells.push({ ch, ink, x: (cell - row * layout.cols) * layout.cellWidth, row });
    return true;
}

/**
 * Walk one page string into laid-out cells: dim toggles flip ink without a
 * cell, sent ink advances past a terminator plus space, wide glyphs pad off
 * row and column edges, and doc lines past the second column drop.
 * @param {string} pageText - Normalized page string with ink toggles.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {number} cols - Printable cells per row (per column for docs).
 * @param {number} rows - Printable text lines per frame.
 * @returns {{ cells: MicroficheLaidCell[], usedRows: number }} Cells plus hugging row count.
 */
function layoutPage(pageText, shape, cols, rows) {
    /** @type {MicroficheLayout} */
    const layout = {
        cells: [],
        doc: shape.columns === 2,
        wideCells: usesWideCells(shape),
        blackInk: shape.variant !== 'sent',
        cols,
        rows,
        cellWidth: shape.cellWidth,
        dim: false,
        sentence: 0,
        cursor: 0,
        line: 0,
    };
    const chars = [...pageText];
    for (let index = 0; index < chars.length; index += 1) {
        const ch = chars[index] ?? '';
        if (ch === DIM_ON || ch === DIM_OFF) {
            layout.dim = ch === DIM_ON;
            continue;
        }
        if (layout.doc && ch === '\n') {
            layout.line += 1;
            layout.cursor = 0;
            if (layout.line >= rows * 2) {
                break;
            }
            continue;
        }
        layout.next = chars[index + 1];
        if (!placeCell(layout, ch, takeInk(layout, ch))) {
            break;
        }
    }
    const lastRow = layout.cells.length > 0 ? (layout.cells[layout.cells.length - 1]?.row ?? 0) : 0;
    const usedRows = layout.doc
        ? Math.min(rows, layout.line + 1)
        : layout.cells.length > 0
          ? Math.min(rows, lastRow + 1)
          : 1;
    return { cells: layout.cells, usedRows };
}

/**
 * Blit one glyph's bitmask rows at (`left`, `top`). One fillRect per set
 * pixel keeps the palette ink exact; rows and columns outside the canvas are
 * skipped so oversized glyphs clip without a path.
 * @param {{ ctx: { fillStyle: string, fillRect: (x: number, y: number, w: number, h: number) => void }, glyph: import('./microfiche-fonts.js').MicroficheGlyph, left: number, top: number, width: number, height: number }} options - Blit target, glyph, and canvas bounds.
 * @returns {void}
 */
function blitGlyph({ ctx, glyph, left, top, width, height }) {
    for (let row = 0; row < glyph.rows.length; row += 1) {
        const bits = glyph.rows[row] ?? 0;
        if (bits === 0) {
            continue;
        }
        const y = top + row;
        if (y < 0 || y >= height) {
            continue;
        }
        for (let column = 0; column < glyph.width; column += 1) {
            if ((bits & (0x80 >> column)) === 0) {
                continue;
            }
            const x = left + column;
            if (x >= 0 && x < width) {
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }
}

/**
 * Draw one normalized page string on an injected canvas. The canvas factory
 * keeps this module host-free: the browser passes document-backed creation
 * while tests record calls. Glyphs blit from the parsed bitmap font at natural
 * size with the baseline at the font ascent from each cell top, so taller
 * cells pad below the baseline. Height hugs the printed rows with a 64px
 * floor.
 * @param {string} pageText - Normalized page string with ink toggles.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {(width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, fillRect: (x: number, y: number, w: number, h: number) => void } }} canvasFactory - Injected canvas source.
 * @returns {MicroficheDrawnPage} Canvas size plus laid-out cells.
 */
export function drawMicrofichePage(pageText, shape, canvasFactory) {
    const { cols, rows, repeat } = frameGrid(shape);
    const { cells, usedRows } = layoutPage(pageText, shape, cols, rows);
    const contentHeight = usedRows * repeat * shape.cellHeight;
    const height = Math.max(MIN_FRAME_HEIGHT, contentHeight);
    const { canvas, ctx } = canvasFactory(shape.frameSize, height);
    const font = getMicroficheFont(shape.font);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, shape.frameSize, height);
    // Copies after the first sit on a pale highlight band (redundancy coding).
    if (repeat > 1) {
        ctx.fillStyle = REPEAT_BAND;
        for (let row = 0; row < usedRows; row += 1) {
            for (let copy = 1; copy < repeat; copy += 1) {
                const bandTop = (row * repeat + copy) * shape.cellHeight;
                if (bandTop < contentHeight) {
                    ctx.fillRect(0, bandTop, shape.frameSize, shape.cellHeight);
                }
            }
        }
    }
    for (const cell of cells) {
        for (let copy = 0; copy < repeat; copy += 1) {
            const cellTop = (cell.row * repeat + copy) * shape.cellHeight;
            if (cellTop >= contentHeight) {
                continue;
            }
            if (cell.ch === FULL_BLOCK) {
                ctx.fillStyle = BLACK_INK;
                ctx.fillRect(cell.x, cellTop, shape.cellWidth, shape.cellHeight);
                continue;
            }
            if (font === null) {
                continue;
            }
            const glyph = font.glyphs.get(cell.ch.codePointAt(0) ?? -1);
            if (glyph === undefined || glyph.rows.length === 0) {
                continue;
            }
            ctx.fillStyle = cell.ink;
            const left = cell.x + glyph.xOffset;
            const top = cellTop + font.ascent - glyph.height - glyph.yOffset;
            blitGlyph({
                ctx,
                glyph,
                left,
                top,
                width: canvas.width,
                height: canvas.height,
            });
        }
    }
    return { width: canvas.width, height: canvas.height, cells };
}
