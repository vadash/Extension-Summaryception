// Microfiche pagination: explicit-knob shape, grid capacity, word wrap, and
// capped page slicing. Pure string math, no DOM.

import { DIM_OFF, DIM_ON, dimStopwords, normalize } from './microfiche-normalize.js';
import { charCells, frameGrid, nextCell, usesWideCells } from './microfiche-geometry.js';

/**
 * @typedef {object} MicrofichePageSplit
 * @property {string[]} imageTexts - Pages bound for image frames.
 * @property {string[]} rawTexts - Pages past the effective cap, in order.
 */

/**
 * Read the render shape from the explicit knob keys only. Preset selectors,
 * retention caps, and keep-raw counts never reach the renderer, so custom
 * knob combinations stay preset-agnostic.
 * @param {Record<string, unknown>} settings - Settings or knob bag.
 * @returns {import('./microfiche-geometry.js').MicroficheShape} Resolved render shape.
 */
export function resolveMicroficheShape(settings) {
    const source = settings ?? {};
    return {
        font: /** @type {import('./microfiche-geometry.js').MicroficheShape['font']} */ (
            source.microficheFont
        ),
        cellWidth: /** @type {number} */ (source.microficheCellWidth),
        cellHeight: /** @type {number} */ (source.microficheCellHeight),
        stretch: /** @type {boolean} */ (source.microficheStretch),
        variant: /** @type {import('./microfiche-geometry.js').MicroficheShape['variant']} */ (
            source.microficheVariant
        ),
        stopwordDim: /** @type {boolean} */ (source.microficheStopwordDim),
        columns: /** @type {import('./microfiche-geometry.js').MicroficheShape['columns']} */ (
            source.microficheColumns
        ),
        lineRepeat: /** @type {number} */ (source.microficheLineRepeat),
        frameSize: /** @type {number} */ (source.microficheFrameSize),
    };
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
        let at = nextCell(cell, size, cols, false);
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
 * @param {import('./microfiche-geometry.js').MicroficheGeometry} geo - Frame grid.
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
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Resolved render shape.
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
    const geo = frameGrid(shape, shape.frameSize);
    const wideCells = usesWideCells(shape);
    const rawPages =
        shape.columns === 2
            ? docPages(joined, geo, wideCells)
            : paginateCells(joined, geo.capacity, geo.cols, wideCells);
    // A dim span cut by a page edge must reopen on the next page, or the
    // remainder of that page prints bright. Track it across pages here.
    let dimOpen = false;
    const paged = rawPages.map((page) => {
        const carried = dimOpen ? `${DIM_ON}${page}` : page;
        dimOpen = carried.lastIndexOf(DIM_ON) > carried.lastIndexOf(DIM_OFF);
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
