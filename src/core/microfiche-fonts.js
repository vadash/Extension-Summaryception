// Microfiche bitmap fonts: snapcompact's public-domain BDF and unscii hex
// assets parsed into per-code-point bitmasks. Pure text in, no host or DOM.

import { DIM_OFF, DIM_ON, NEWLINE_GLYPH } from './microfiche-normalize.js';

/**
 * @typedef {object} MicroficheGlyph
 * @property {number} width - Glyph width in pixels.
 * @property {number} height - Glyph height in pixels.
 * @property {number} xOffset - Left bearing from the cell origin.
 * @property {number} yOffset - Descent offset from the baseline.
 * @property {number[]} rows - One bitmask per bitmap row, MSB leftmost.
 */

/**
 * @typedef {object} MicroficheFont
 * @property {string} name - Preset label the font was parsed under.
 * @property {number} cellWidth - Natural cell advance in pixels.
 * @property {number} cellHeight - Natural cell pitch in pixels.
 * @property {number} ascent - Baseline row from the cell top.
 * @property {Map<number, MicroficheGlyph>} glyphs - Glyphs keyed by code point.
 */

/**
 * Bitmap preset labels and the vendored asset each one parses.
 * @type {Readonly<Record<string, string>>}
 */
export const MICROFICHE_FONT_FILES = Object.freeze({
    '5x8': '5x8.bdf',
    '8x8': 'unscii-8.hex',
    '6x12': '6x12.bdf',
    '8x13': '8x13.bdf',
});

/**
 * Preset labels in render order.
 * @type {Readonly<string[]>}
 */
export const MICROFICHE_FONT_NAMES = Object.freeze(Object.keys(MICROFICHE_FONT_FILES));

// Renderer control codes print without a font glyph, matching snapcompact.
const ALWAYS_SUPPORTED = new Set([
    0x0a,
    DIM_ON.codePointAt(0),
    DIM_OFF.codePointAt(0),
    NEWLINE_GLYPH.codePointAt(0),
]);

/**
 * Read the four integers after a BDF keyword.
 * @param {string} line - Trimmed BDF line.
 * @returns {number[]} Parsed numbers, zero-filled when absent.
 */
function readNumbers(line) {
    return line
        .split(/\s+/)
        .slice(1, 5)
        .map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * Parse an X.org BDF source. The parser accepts LF, CRLF, or CR line endings
 * because the assets are checked in with `* text=auto eol=lf` and a Windows
 * checkout may hand the renderer CRLF text.
 * @param {string} name - Preset label.
 * @param {string} text - BDF source.
 * @returns {MicroficheFont} Parsed font.
 */
function parseBdfFont(name, text) {
    let cellWidth = 0;
    let cellHeight = 0;
    let ascent = 0;
    let encoding = -1;
    /** @type {[number, number, number, number]} */
    let bbx = [0, 0, 0, 0];
    /** @type {Map<number, MicroficheGlyph>} */
    const glyphs = new Map();
    const lines = text.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line.startsWith('FONTBOUNDINGBOX')) {
            const [width, height] = readNumbers(line);
            cellWidth = width;
            cellHeight = height;
        } else if (line.startsWith('FONT_ASCENT')) {
            ascent = Number.parseInt(line.slice('FONT_ASCENT'.length), 10) || 0;
        } else if (line.startsWith('ENCODING')) {
            encoding = Number.parseInt(line.slice('ENCODING'.length), 10);
        } else if (line.startsWith('BBX')) {
            const [width, height, xOffset, yOffset] = readNumbers(line);
            bbx = [width, height, xOffset, yOffset];
        } else if (line === 'BITMAP') {
            /** @type {number[]} */
            const rows = [];
            for (index += 1; index < lines.length; index += 1) {
                const row = lines[index].trim();
                if (row.startsWith('ENDCHAR')) {
                    break;
                }
                if (row) {
                    rows.push(Number.parseInt(row, 16) & 0xff);
                }
            }
            if (Number.isInteger(encoding) && encoding >= 0) {
                glyphs.set(encoding, {
                    width: bbx[0],
                    height: bbx[1],
                    xOffset: bbx[2],
                    yOffset: bbx[3],
                    rows,
                });
            }
            encoding = -1;
        }
    }
    return { name, cellWidth, cellHeight, ascent, glyphs };
}

/**
 * Parse a unifont-style `.hex` source (`CODEPOINT:16-hex-digit bitmap`, one
 * byte per row of an 8x8 glyph). The baseline sits at row 7.
 * @param {string} name - Preset label.
 * @param {string} text - Hex source.
 * @returns {MicroficheFont} Parsed font.
 */
function parseUnifontHexFont(name, text) {
    /** @type {Map<number, MicroficheGlyph>} */
    const glyphs = new Map();
    for (const source of text.split(/\r\n|\r|\n/)) {
        const line = source.trim();
        const separator = line.indexOf(':');
        if (separator < 0) {
            continue;
        }
        const codePoint = Number.parseInt(line.slice(0, separator).trim(), 16);
        const bits = line.slice(separator + 1).trim();
        if (!Number.isInteger(codePoint) || bits.length !== 16) {
            continue;
        }
        /** @type {number[]} */
        const rows = [];
        for (let offset = 0; offset < bits.length; offset += 2) {
            rows.push(Number.parseInt(bits.slice(offset, offset + 2), 16) & 0xff);
        }
        glyphs.set(codePoint, { width: 8, height: 8, xOffset: 0, yOffset: -1, rows });
    }
    return { name, cellWidth: 8, cellHeight: 8, ascent: 7, glyphs };
}

/**
 * Parse one vendored bitmap font. The BDF files carry their own natural cell
 * box and ascent; unscii-8 is always an 8x8 cell with ascent 7.
 * @param {string} name - One of MICROFICHE_FONT_NAMES.
 * @param {string} text - BDF or unscii hex source.
 * @returns {MicroficheFont} Parsed font.
 */
export function parseMicroficheFont(name, text) {
    if (!Object.hasOwn(MICROFICHE_FONT_FILES, name)) {
        throw new Error(`Unknown microfiche font ${JSON.stringify(name)}`);
    }
    return name === '8x8' ? parseUnifontHexFont(name, text) : parseBdfFont(name, String(text));
}

/**
 * Return the subset of `text` the font can render. Renderer control codes
 * count as supported because the draw interprets them outside glyph lookup;
 * uncovered characters are dropped so callers fold them to `?`.
 * @param {MicroficheFont} font - Parsed font.
 * @param {string} text - Characters to test.
 * @returns {string} Supported characters in source order.
 */
export function supportedChars(font, text) {
    let supported = '';
    for (const ch of String(text ?? '')) {
        const codePoint = ch.codePointAt(0);
        if (
            codePoint !== undefined &&
            (ALWAYS_SUPPORTED.has(codePoint) || font.glyphs.has(codePoint))
        ) {
            supported += ch;
        }
    }
    return supported;
}
