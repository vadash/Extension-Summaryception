// Microfiche pagination: explicit-knob shape, grid capacity, and word wrap.
// Pure string math, no DOM.

import { DIM_OFF, DIM_ON, NEWLINE_GLYPH, dimStopwords, normalize } from './microfiche-normalize.js';
import { charCells, frameGrid, nextCell, usesWideCells } from './microfiche-geometry.js';

/**
 * @typedef {object} MicrofichePageSplit
 * @property {string[]} imageTexts - Pages bound for image frames.
 * @property {string[]} rawTexts - Pages kept as text; pagination never slices, so this stays empty.
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
        stretch: false,
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
 * Index of the last page break before end: a sentence period or a newline
 * boundary. Page Split never aligns to messages, so a message may span pages.
 * @param {string[]} chars - Characters of the normalized text.
 * @param {number} start - First character of the current page.
 * @param {number} end - First character that overflows the page.
 * @returns {number} Break index, or -1 when the page holds no break.
 */
function lastPageBreak(chars, start, end) {
    for (let index = end - 1; index >= start; index -= 1) {
        const ch = chars[index];
        if (ch === '.' || ch === NEWLINE_GLYPH) {
            return index;
        }
    }
    return -1;
}

/**
 * Split text into pages of at most capacity grid cells, inserting a one-cell
 * pad before a wide glyph that would straddle the right edge. Pages are
 * contiguous substrings, so joining them reproduces the input exactly. A page
 * ends after the last `.` or newline that fits, and hard-cuts only when the
 * page holds neither, which keeps page breaks inside messages.
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
    while (start < chars.length) {
        let cell = 0;
        let hasCell = false;
        let index = start;
        for (; index < chars.length; index += 1) {
            const size = charCells(chars[index] ?? '', wideCells);
            if (size === 0) {
                continue;
            }
            const at = nextCell(cell, size, cols, false);
            if (hasCell && at + size > capacity) {
                break;
            }
            cell = at + size;
            hasCell = true;
        }
        let cut = index;
        if (index < chars.length) {
            const boundary = lastPageBreak(chars, start, index);
            if (boundary >= start) {
                cut = boundary + 1;
                // The space after a sentence stays on the finished page so
                // the next page starts on its first glyph.
                if (cut < index && chars[cut] === ' ') {
                    cut += 1;
                }
            }
        }
        if (hasCell) {
            pages.push(chars.slice(start, cut).join(''));
        }
        start = cut;
    }
    return pages;
}

/**
 * Split text after every newline glyph so a message boundary always ends a
 * wrapped line. Zero-width ink toggles are not line breaks; only the glyph is.
 * @param {string} text - Normalized text.
 * @returns {string[]} Chunks, each ending with a newline glyph except the last.
 */
function newlineChunks(text) {
    const chunks = [];
    let current = '';
    for (const ch of text) {
        current += ch;
        if (ch === NEWLINE_GLYPH) {
            chunks.push(current);
            current = '';
        }
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
}

/**
 * Greedy word wrap with no mid-word breaks; overlong words hard-split at
 * the column width. A newline glyph ends its line so page breaks can fall on
 * message boundaries. Zero-width dim toggles count toward word length here,
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
    const flush = () => {
        if (current) {
            lines.push(current);
            current = '';
            currentCells = 0;
        }
    };
    for (const chunk of newlineChunks(text)) {
        for (const token of chunk.split(/\s+/)) {
            if (token.length === 0) {
                continue;
            }
            let word = token;
            let wordCells = cellLength(word, wideCells);
            while (wordCells > width) {
                flush();
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
                flush();
                current = word;
                currentCells = wordCells;
            }
        }
        flush();
    }
    return lines;
}

/**
 * Index of the last line that ends a page break, or end when none does.
 * A line ending in `.` or a newline glyph keeps the next page on a natural
 * boundary; hard-cutting at the row count remains the fallback.
 * @param {string[]} lines - Wrapped lines.
 * @param {number} start - First line of the current page.
 * @param {number} end - First line past the page's row capacity.
 * @returns {number} Exclusive line index for the page end.
 */
function docPageBreak(lines, start, end) {
    for (let index = end; index > start; index -= 1) {
        const line = lines[index - 1] ?? '';
        if (line.endsWith('.') || line.endsWith(NEWLINE_GLYPH)) {
            return index;
        }
    }
    return end;
}

/**
 * Paginate normalized text for a newspaper shape: wrap once at the column
 * width, then slice lines into pages of 2 * rows. A page ends after the last
 * line that ends a sentence or a newline, so a message may span two pages
 * without forcing page alignment.
 * @param {string} normalized - Normalized text.
 * @param {import('./microfiche-geometry.js').MicroficheGeometry} geo - Frame grid.
 * @param {boolean} wideCells - Whether wide glyphs span two cells.
 * @returns {string[]} Page strings in order.
 */
function docPages(normalized, geo, wideCells) {
    const lines = wrapLines(normalized, geo.cols, wideCells);
    const perPage = 2 * geo.rows;
    const pages = [];
    let offset = 0;
    while (offset < lines.length) {
        const end = Math.min(lines.length, offset + perPage);
        const cut = end < lines.length ? docPageBreak(lines, offset, end) : end;
        pages.push(lines.slice(offset, cut).join('\n'));
        offset = cut;
    }
    return pages;
}

/**
 * Paginate already image-bound snippet texts: normalize each, join in
 * chronological order, paginate to frame capacity, then stopword-dim after
 * pagination so capacity math never sees the zero-width markers. Emits
 * strings only; the Canvas2D slice turns each into a { dataUrl, text } page.
 * The plan owns the image cap, so this returns every page.
 * @param {string[]} textsToImages - Snippet texts bound for image frames.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Resolved render shape.
 * @returns {MicrofichePageSplit} Page texts for images; rawTexts is empty here.
 */
export function buildMicrofichePageTexts(textsToImages, shape) {
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
    return { imageTexts: paged, rawTexts: [] };
}
