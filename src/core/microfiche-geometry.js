// Microfiche text geometry: the one glyph-rule table shared by pagination
// capacity math and the Canvas2D draw. Pure math, no DOM.

import { DIM_OFF, DIM_ON } from './microfiche-normalize.js';
import { isWideCodePoint } from './microfiche-wide.js';

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
 * @property {number} repeat - Redundancy prints per text line.
 */

// Char cells between the two newspaper columns.
export const DOC_GUTTER = 3;

/**
 * @param {string} ch - One Unicode character.
 * @param {boolean} wideCells - Whether wide glyphs span two cells.
 * @returns {number} Grid cells the character occupies.
 */
export function charCells(ch, wideCells) {
    if (ch === DIM_ON || ch === DIM_OFF) {
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
export function usesWideCells(shape) {
    return shape.font !== 'silver';
}

/**
 * Straddle pad: a wide glyph never starts on the last cell of a row.
 * @param {number} cell - Candidate cell index.
 * @param {number} units - Cells the glyph occupies.
 * @param {number} cols - Cells per row (per column for docs).
 * @param {boolean} doc - Whether newspaper columns split the grid.
 * @returns {number} Cell index after the straddle pad.
 */
export function nextCell(cell, units, cols, doc) {
    if (units === 2 && cols >= 2 && (doc ? cell === cols - 1 : cell % cols === cols - 1)) {
        return cell + 1;
    }
    return cell;
}

/**
 * Grid capacity for one frame: columns of cellWidth by rows of cellHeight
 * and lineRepeat. Two columns split the grid around the gutter; each half
 * wraps independently, so capacity is twice one column. Degenerate frames
 * clamp to one printable cell so capacity and draw never divide by zero.
 * @param {MicroficheShape} shape - Resolved render shape.
 * @param {number} size - Frame edge in pixels.
 * @returns {MicroficheGeometry} Printable grid for the frame.
 */
export function frameGrid(shape, size = shape.frameSize) {
    const repeat = Math.max(1, Math.floor(shape.lineRepeat));
    const gridCols = Math.max(1, Math.floor(size / shape.cellWidth));
    const rows = Math.max(1, Math.floor(size / shape.cellHeight / repeat));
    const cols =
        shape.columns === 2 ? Math.max(1, Math.floor((gridCols - DOC_GUTTER) / 2)) : gridCols;
    const capacity = shape.columns === 2 ? 2 * cols * rows : cols * rows;
    return { cols, rows, capacity, repeat };
}
