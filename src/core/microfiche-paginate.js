// Microfiche pagination: explicit-knob shape, grid capacity, word wrap, and
// capped page slicing. Pure string math, no DOM.

import { dimStopwords, normalize } from './microfiche-normalize.js';

/**
 * @typedef {object} MicroficheShape
 * @property {'5x8' | '8x8' | '6x12' | '8x13' | 'silver'} font - Bitmap cell family.
 * @property {number} cellWidth - Target cell advance in pixels.
 * @property {number} cellHeight - Target cell pitch in pixels.
 * @property {boolean} stretch - Lanczos stretch when the cell differs.
 * @property {'bw' | 'sent'} variant - Ink: plain black or sentence hues.
 * @property {boolean} stopwordDim - Print stopwords in dim ink.
 * @property {1 | 2} columns - 1 is a row-major grid, 2 is newspaper columns.
 * @property {number} lineRepeat - Redundancy prints per text line.
 * @property {number} frameSize - Frame edge in pixels.
 */

/**
 * @typedef {object} MicroficheGeometry
 * @property {number} cols - Printable cells per row (per column for docs).
 * @property {number} rows - Printable text lines per frame.
 * @property {number} capacity - Grid cells per frame.
 */

/**
 * @typedef {object} MicrofichePageSplit
 * @property {string[]} imageTexts - Pages bound for image frames.
 * @property {string[]} rawTexts - Pages past the effective cap, in order.
 */

// Char cells between the two newspaper columns.
const DOC_GUTTER = 3;

// East Asian wide/fullwidth ranges; two grid cells in narrow bitmap shapes.
// Facts shared with the reader path, so capacity math matches the draw.
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
    if (ch === '\u000e' || ch === '\u000f') {
        return 0;
    }
    const codePoint = ch.codePointAt(0);
    return wideCells && codePoint !== undefined && isWideCodePoint(codePoint) ? 2 : 1;
}

/**
 * Wide glyphs span two cells in every shape except silver, whose square
 * cells already fit a full-width glyph.
 * @param {Pick<MicroficheShape, 'font'>} shape
 * @returns {boolean} True when wide code points take two cells.
 */
function usesWideCells(shape) {
    return shape.font !== 'silver';
}

/**
 * Read the render shape from the explicit knob keys only. Preset selectors,
 * retention caps, and keep-raw counts never reach the renderer, so custom
 * knob combinations stay preset-agnostic.
 * @param {Record<string, unknown>} settings - Settings or knob bag.
 * @returns {MicroficheShape} Resolved render shape.
 */
export function resolveMicroficheShape(settings) {
    const source = settings ?? {};
    return {
        font: /** @type {MicroficheShape['font']} */ (source.microficheFont),
        cellWidth: /** @type {number} */ (source.microficheCellWidth),
        cellHeight: /** @type {number} */ (source.microficheCellHeight),
        stretch: /** @type {boolean} */ (source.microficheStretch),
        variant: /** @type {MicroficheShape['variant']} */ (source.microficheVariant),
        stopwordDim: /** @type {boolean} */ (source.microficheStopwordDim),
        columns: /** @type {MicroficheShape['columns']} */ (source.microficheColumns),
        lineRepeat: /** @type {number} */ (source.microficheLineRepeat),
        frameSize: /** @type {number} */ (source.microficheFrameSize),
    };
}

/**
 * Grid capacity for one frame: columns of cellWidth by rows of cellHeight
 * and lineRepeat. Two columns split the grid around the gutter; each half
 * wraps independently, so capacity is twice one column.
 * @param {MicroficheShape} shape - Resolved render shape.
 * @param {number} size - Frame edge in pixels.
 * @returns {MicroficheGeometry} Printable grid for the frame.
 */
export function geometry(shape, size = shape.frameSize) {
    const gridCols = Math.floor(size / shape.cellWidth);
    const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
    if (shape.columns === 2) {
        const cols = Math.floor((gridCols - DOC_GUTTER) / 2);
        return { cols, rows, capacity: 2 * cols * rows };
    }
    return { cols: gridCols, rows, capacity: gridCols * rows };
}

/**
 * Total grid cells a string occupies, ignoring wrap and pads.
 * @param {string} text
 * @param {boolean} wideCells
 * @returns {number} Cell count.
 */
function cellLength(text, wideCells) {
    let cells = 0;
    for (const ch of text) {
        cells += charCells(ch, wideCells);
    }
    return cells;
}

/**
 * Longest prefix of text fitting width cells, at least one character.
 * @param {string} text
 * @param {number} width
 * @param {boolean} wideCells
 * @returns {string} Fitting prefix.
 */
function sliceCells(text, width, wideCells) {
    let cells = 0;
    let out = '';
    let placed = false;
    for (const ch of text) {
        const size = charCells(ch, wideCells);
        if (placed && cells + size > width) {
            break;
        }
        out += ch;
        cells += size;
        if (size > 0) {
            placed = true;
        }
    }
    return out;
}

/**
 * Split text into pages of at most capacity grid cells, inserting a one-cell
 * pad before a wide glyph that would straddle the right edge. Pages are
 * contiguous substrings, so joining them reproduces the input exactly.
 * @param {string} text - Normalized text.
 * @param {number} capacity - Grid cells per page.
 * @param {number} cols - Cells per row, for the straddle pad.
 * @param {boolean} wideCells - Whether wide glyphs span two cells.
 * @returns {string[]} Page strings in order.
 */
function paginateCells(text, capacity, cols, wideCells) {
    const chars = [...text];
    const pages = [];
    let start = 0;
    let cell = 0;
    let hasCell = false;
    for (let index = 0; index < chars.length; index += 1) {
        const size = charCells(chars[index] ?? '', wideCells);
        if (size === 0) {
            continue;
        }
        let at = cell;
        if (size === 2 && cols >= 2 && at % cols === cols - 1) {
            at += 1;
        }
        if (hasCell && at + size > capacity) {
            pages.push(chars.slice(start, index).join(''));
            start = index;
            at = 0;
        }
        cell = at + size;
        hasCell = true;
    }
    if (hasCell) {
        pages.push(chars.slice(start).join(''));
    }
    return pages;
}

/**
 * Greedy word wrap with no mid-word breaks; overlong words hard-split at
 * the column width. Zero-width dim toggles count toward word length here,
 * but serialized text keeps them at word boundaries, so drift stays tiny.
 * @param {string} text - Normalized text.
 * @param {number} width - Column width in cells.
 * @param {boolean} [wideCells] - Whether wide glyphs span two cells.
 * @returns {string[]} Wrapped lines.
 */
function wrapLines(text, width, wideCells = false) {
    const lines = [];
    let current = '';
    let currentCells = 0;
    for (const token of text.split(/\s+/)) {
        if (token.length === 0) {
            continue;
        }
        let word = token;
        let wordCells = cellLength(word, wideCells);
        while (wordCells > width) {
            if (current) {
                lines.push(current);
                current = '';
                currentCells = 0;
            }
            const head = sliceCells(word, width, wideCells);
            lines.push(head);
            word = word.slice(head.length);
            wordCells = cellLength(word, wideCells);
        }
        if (!current) {
            current = word;
            currentCells = wordCells;
        } else if (currentCells + 1 + wordCells <= width) {
            current += ` ${word}`;
            currentCells += 1 + wordCells;
        } else {
            lines.push(current);
            current = word;
            currentCells = wordCells;
        }
    }
    if (current) {
        lines.push(current);
    }
    return lines;
}

/**
 * Paginate normalized text for a newspaper shape: wrap once at the column
 * width, then slice lines into pages of 2 * rows. Whitespace becomes the
 * wrap points, so every input character lands on exactly one page.
 * @param {string} normalized - Normalized text.
 * @param {MicroficheGeometry} geo - Frame grid.
 * @param {boolean} wideCells - Whether wide glyphs span two cells.
 * @returns {string[]} Page strings in order.
 */
function docPages(normalized, geo, wideCells) {
    const lines = wrapLines(normalized, geo.cols, wideCells);
    const perPage = 2 * geo.rows;
    const pages = [];
    for (let offset = 0; offset < lines.length; offset += perPage) {
        pages.push(lines.slice(offset, offset + perPage).join('\n'));
    }
    return pages;
}

/**
 * Paginate already image-bound snippet texts: normalize each, join in
 * chronological order, paginate to frame capacity, then stopword-dim after
 * pagination so capacity math never sees the zero-width markers. Emits
 * strings only; the Canvas2D slice turns each into a { dataUrl, text } page.
 * The optional cap slices pages; pages past it stay in rawTexts in order, so
 * overflow stays text and nothing drops silently.
 * @param {string[]} textsToImages - Snippet texts bound for image frames.
 * @param {MicroficheShape} shape - Resolved render shape.
 * @param {unknown} [effectiveCap] - Optional image-page budget; absent means uncapped.
 * @returns {MicrofichePageSplit} Page texts for images plus raw overflow pages.
 */
export function buildMicrofichePageTexts(textsToImages, shape, effectiveCap) {
    const source = Array.isArray(textsToImages) ? textsToImages : [];
    const joined = normalize(source.filter((text) => typeof text === 'string').join('\n'), {
        font: shape.font,
    });
    if (!joined) {
        return { imageTexts: [], rawTexts: [] };
    }
    const geo = geometry(shape, shape.frameSize);
    const wideCells = usesWideCells(shape);
    const rawPages =
        shape.columns === 2
            ? docPages(joined, geo, wideCells)
            : paginateCells(joined, geo.capacity, geo.cols, wideCells);
    // A dim span cut by a page edge must reopen on the next page, or the
    // remainder of that page prints bright. Track it across pages here.
    let dimOpen = false;
    const paged = rawPages.map((page) => {
        const carried = dimOpen ? '\u000e' + page : page;
        dimOpen = carried.lastIndexOf('\u000e') > carried.lastIndexOf('\u000f');
        return shape.stopwordDim ? dimStopwords(carried) : carried;
    });
    if (effectiveCap === undefined || effectiveCap === null) {
        return { imageTexts: paged, rawTexts: [] };
    }
    const cap = Number.isFinite(Number(effectiveCap))
        ? Math.max(0, Math.floor(Number(effectiveCap)))
        : 0;
    return { imageTexts: paged.slice(0, cap), rawTexts: paged.slice(cap) };
}
