// Microfiche Canvas2D renderer: pure grid layout, host-free raster seeding.
// Same state machine as the native frame printer (ported ideas only): one
// layout walk feeds both the height measure and the painter, so capacity math
// and drawing cannot disagree. Row-major grid or two newspaper columns.

// Zero-width ink toggles ride in page strings from slice 1 and take no cell.
const DIM_ON = '\u000e';
const DIM_OFF = '\u000f';
// Newline runs folded to one full-ink cell by the slice-1 normalizer.
const FULL_BLOCK = '█';

// Six dark sentence hues for the sent variant (values from the native indexed
// palette: HLS l=0.22 s=0.95, h in {0, .08, .3, .5, .62, .78}).
const SENTENCE_HUES = ['#6d0202', '#6d3502', '#186d02', '#026d6d', '#02206d', '#4b026d'];
const DIM_INK = '#808080';
const BLACK_INK = '#000000';
const REPEAT_BAND = '#fff7c2';

// Char cells between the two newspaper columns; matches slice-1 pagination.
const DOC_GUTTER = 3;
// Vision processors reject tiny frames, so short pages pad to this height.
const MIN_FRAME_HEIGHT = 64;
// Monospace advance runs about 0.6em, so the px size is the cell pitch
// clamped to the advance-fit width; every fillText lands in its cell box.
const MONOSPACE_ADVANCE = 0.6;
const FONT_FAMILY = 'monospace';

// East Asian wide/fullwidth ranges; two grid cells in narrow bitmap shapes.
// Values shared with slice 1, so capacity math matches the draw.
const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0x2eff],
    [0x2f00, 0x2fdf],
    [0x3000, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe4f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];

/**
 * @param {number} codePoint
 * @returns {boolean} True for East Asian wide/fullwidth ranges.
 */
function isWideCodePoint(codePoint) {
    return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/**
 * @param {string} ch - One Unicode character.
 * @param {boolean} wideCells - Whether wide glyphs span two cells.
 * @returns {number} Grid cells the character occupies.
 */
function charCells(ch, wideCells) {
    if (ch === DIM_ON || ch === DIM_OFF) {
        return 0;
    }
    const codePoint = ch.codePointAt(0);
    return wideCells && codePoint !== undefined && isWideCodePoint(codePoint) ? 2 : 1;
}

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
    let cell = layout.cursor;
    if (
        units === 2 &&
        layout.cols >= 2 &&
        (layout.doc ? cell === layout.cols - 1 : cell % layout.cols === layout.cols - 1)
    ) {
        cell += 1;
    }
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
 * @param {import('./microfiche-paginate.js').MicroficheShape} shape - Render shape.
 * @param {number} cols - Printable cells per row (per column for docs).
 * @param {number} rows - Printable text lines per frame.
 * @returns {{ cells: MicroficheLaidCell[], usedRows: number }} Cells plus hugging row count.
 */
function layoutPage(pageText, shape, cols, rows) {
    /** @type {MicroficheLayout} */
    const layout = {
        cells: [],
        doc: shape.columns === 2,
        wideCells: shape.font !== 'silver',
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
 * Draw one normalized page string on an injected canvas. The canvas factory
 * keeps this module host-free: the browser passes document-backed creation
 * while tests record calls. Height hugs the printed rows with a 64px floor.
 * @param {string} pageText - Normalized page string with ink toggles.
 * @param {import('./microfiche-paginate.js').MicroficheShape} shape - Render shape.
 * @param {(width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, font: string, textBaseline: string, fillRect: (x: number, y: number, w: number, h: number) => void, fillText: (text: string, x: number, y: number) => void } }} canvasFactory - Injected canvas source.
 * @returns {MicroficheDrawnPage} Canvas size plus laid-out cells.
 */
export function drawMicrofichePage(pageText, shape, canvasFactory) {
    const gridCols = Math.max(1, Math.floor(shape.frameSize / shape.cellWidth));
    const rows = Math.max(1, Math.floor(shape.frameSize / shape.cellHeight / shape.lineRepeat));
    const cols =
        shape.columns === 2 ? Math.max(1, Math.floor((gridCols - DOC_GUTTER) / 2)) : gridCols;
    const repeat = Math.max(1, Math.floor(shape.lineRepeat));
    const { cells, usedRows } = layoutPage(pageText, shape, cols, rows);
    const contentHeight = usedRows * repeat * shape.cellHeight;
    const height = Math.max(MIN_FRAME_HEIGHT, contentHeight);
    const { canvas, ctx } = canvasFactory(shape.frameSize, height);
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
    ctx.font = `${Math.max(1, Math.min(shape.cellHeight, shape.cellWidth / MONOSPACE_ADVANCE))}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    for (const cell of cells) {
        for (let copy = 0; copy < repeat; copy += 1) {
            const y = (cell.row * repeat + copy) * shape.cellHeight;
            if (y >= contentHeight) {
                continue;
            }
            if (cell.ch === FULL_BLOCK) {
                ctx.fillStyle = BLACK_INK;
                ctx.fillRect(cell.x, y, shape.cellWidth, shape.cellHeight);
                continue;
            }
            ctx.fillStyle = cell.ink;
            ctx.fillText(cell.ch, cell.x, y);
        }
    }
    return { width: canvas.width, height: canvas.height, cells };
}
