import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    MICROFICHE_FONT_FILES,
    MICROFICHE_FONT_NAMES,
    parseMicroficheFont,
    supportedChars,
} from '../src/core/microfiche-fonts.js';

// Vendored snapcompact bitmap fonts, parsed at load. The expected bits below
// come from the font files themselves, never from the parser under test.

const FONT_DIR = new URL('../fonts/', import.meta.url);
const parsed = new Map();

function loadFont(name) {
    if (!parsed.has(name)) {
        const source = readFileSync(new URL(MICROFICHE_FONT_FILES[name], FONT_DIR), 'utf8');
        parsed.set(name, parseMicroficheFont(name, source));
    }
    return parsed.get(name);
}

describe('microfiche font assets', () => {
    it('maps the four bitmap labels to their font files', () => {
        expect(MICROFICHE_FONT_FILES).toEqual({
            '5x8': '5x8.bdf',
            '8x8': 'unscii-8.hex',
            '6x12': '6x12.bdf',
            '8x13': '8x13.bdf',
        });
        expect(MICROFICHE_FONT_NAMES).toEqual(['5x8', '8x8', '6x12', '8x13']);
    });
});

describe('parseMicroficheFont', () => {
    it('reports each font natural cell size and ascent', () => {
        const cells = Object.fromEntries(
            MICROFICHE_FONT_NAMES.map((name) => {
                const font = loadFont(name);
                return [
                    name,
                    {
                        cellWidth: font.cellWidth,
                        cellHeight: font.cellHeight,
                        ascent: font.ascent,
                    },
                ];
            }),
        );
        expect(cells).toEqual({
            '5x8': { cellWidth: 5, cellHeight: 8, ascent: 7 },
            '8x8': { cellWidth: 8, cellHeight: 8, ascent: 7 },
            '6x12': { cellWidth: 6, cellHeight: 12, ascent: 10 },
            '8x13': { cellWidth: 8, cellHeight: 13, ascent: 11 },
        });
    });

    it('reads 5x8 BDF glyph bits keyed by code point', () => {
        expect(loadFont('5x8').glyphs.get(0x41)).toEqual({
            width: 5,
            height: 8,
            xOffset: 0,
            yOffset: -1,
            rows: [0x00, 0x60, 0x90, 0x90, 0xf0, 0x90, 0x90, 0x00],
        });
    });

    it('reads 8x13 BDF glyph bits keyed by code point', () => {
        expect(loadFont('8x13').glyphs.get(0x41)).toEqual({
            width: 8,
            height: 13,
            xOffset: 0,
            yOffset: -2,
            rows: [0x00, 0x00, 0x18, 0x24, 0x42, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x42, 0x00, 0x00],
        });
    });

    it('reads unscii-8 hex glyph bits keyed by code point', () => {
        expect(loadFont('8x8').glyphs.get(0x41)).toEqual({
            width: 8,
            height: 8,
            xOffset: 0,
            yOffset: -1,
            rows: [0x18, 0x3c, 0x66, 0x66, 0x7e, 0x66, 0x66, 0x00],
        });
    });

    it('parses CRLF source without changing glyph bits', () => {
        const bdf = [
            'STARTFONT 2.1',
            'FONTBOUNDINGBOX 5 8 0 -1',
            'FONT_ASCENT 7',
            'STARTCHAR A',
            'ENCODING 65',
            'BBX 5 8 0 -1',
            'BITMAP',
            '00',
            '60',
            '90',
            '90',
            'F0',
            '90',
            '90',
            '00',
            'ENDCHAR',
            'ENDFONT',
        ].join('\r\n');
        const font = parseMicroficheFont('5x8', bdf);
        expect(font.cellWidth).toBe(5);
        expect(font.glyphs.get(0x41)?.rows).toEqual([
            0x00, 0x60, 0x90, 0x90, 0xf0, 0x90, 0x90, 0x00,
        ]);

        const hex = parseMicroficheFont('8x8', '00041:183C66667E666600\r\n');
        expect(hex.glyphs.get(0x41)?.rows).toEqual([
            0x18, 0x3c, 0x66, 0x66, 0x7e, 0x66, 0x66, 0x00,
        ]);
    });
});

describe('microfiche font coverage', () => {
    it('keeps Cyrillic text covered by 6x12 and 8x13', () => {
        const cyrillic = 'Вова$$засмотрелся$$на$$ее';
        expect(supportedChars(loadFont('6x12'), cyrillic)).toBe(cyrillic);
        expect(supportedChars(loadFont('8x13'), cyrillic)).toBe(cyrillic);
    });

    it('reports CJK uncovered and drops it from the supported subset', () => {
        expect(supportedChars(loadFont('8x13'), 'Вова界')).toBe('Вова');
        expect(supportedChars(loadFont('6x12'), '界')).toBe('');
    });

    it('does not claim Cyrillic for the 5x8 and 8x8 fonts', () => {
        expect(supportedChars(loadFont('5x8'), 'Вова')).toBe('');
        expect(supportedChars(loadFont('8x8'), 'Вова')).toBe('');
    });

    it('keeps renderer control codes and Latin-1 coverage', () => {
        const text = '\n\u000e\u000f█é';
        expect(supportedChars(loadFont('8x8'), text)).toBe(text);
        expect(supportedChars(loadFont('5x8'), 'é界')).toBe('é');
    });
});

describe('microfiche font Cyrillic encoding', () => {
    it('reads ENCODING 1024 (U+0400) from 6x12 and 8x13 only', () => {
        expect(loadFont('5x8').glyphs.has(1024)).toBe(false);
        expect(loadFont('6x12').glyphs.has(1024)).toBe(true);
        expect(loadFont('8x13').glyphs.get(1024)).toEqual({
            width: 8,
            height: 13,
            xOffset: 0,
            yOffset: -2,
            rows: [0x00, 0x10, 0x08, 0x00, 0x7e, 0x40, 0x40, 0x7c, 0x40, 0x40, 0x7e, 0x00, 0x00],
        });
    });
});
