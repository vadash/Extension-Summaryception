import { describe, expect, it } from 'vitest';

import {
    DIM_OFF,
    DIM_ON,
    NEWLINE_GLYPH,
    dimStopwords,
    normalize,
    scanRenderability,
} from '../src/core/microfiche-normalize.js';
import {
    buildMicrofichePageTexts,
    geometry,
    resolveMicroficheShape,
    splitKeepRaw,
} from '../src/core/microfiche-paginate.js';

// Legibility parity only: this suite pins structure and order (page strings,
// chronology, capacity math). It never compares PNG bytes, and the page texts
// below carry no image payloads, so a byte-equality assertion cannot live here.

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

describe('microfiche normalize', () => {
    it('collapses whitespace and trims edges', () => {
        expect(normalize('  hello   world  ')).toBe('hello world');
        expect(normalize('')).toBe('');
        expect(normalize(null)).toBe('');
    });

    it('strips ANSI escape sequences', () => {
        expect(normalize('\u001b[31mRED\u001b[0m plain')).toBe('RED plain');
    });

    it('prints newline runs as one newline glyph cell', () => {
        expect(normalize('a\n\nb')).toBe(`a${NEWLINE_GLYPH}b`);
    });

    it('folds box drawing to ASCII', () => {
        expect(normalize('a─b│c┌d')).toBe('a-b|c+d');
    });

    it('folds punctuation, arrows, and status emoji', () => {
        expect(normalize('\u201chi\u201d\u2014she said \u2022 ok \u2192 go \u2705')).toBe(
            '"hi"-she said * ok -> go [OK]',
        );
    });

    it('drops decorative emoji instead of burning cells', () => {
        expect(normalize('party \u{1F389} done')).toBe('party done');
    });

    it('falls back to ? for glyphs no font covers', () => {
        expect(normalize('\u03b1')).toBe('?');
    });

    it('keeps zero-width dim toggles untouched', () => {
        expect(normalize(`a${DIM_ON}b${DIM_OFF}c`)).toBe(`a${DIM_ON}b${DIM_OFF}c`);
    });
});

describe('microfiche scanRenderability', () => {
    it('marks plain prose safe with a zero ratio', () => {
        expect(scanRenderability('plain ascii words here')).toEqual({
            isSafe: true,
            unrenderableRatio: 0,
        });
    });

    it('marks fallback-heavy text unsafe past the 5% threshold', () => {
        expect(scanRenderability('\u03b1'.repeat(20)).isSafe).toBe(false);
    });

    it('treats exactly 5% fallback as safe', () => {
        const probe = 'a'.repeat(19) + '\u03b1';
        const result = scanRenderability(probe);
        expect(result.isSafe).toBe(true);
        expect(result.unrenderableRatio).toBeCloseTo(0.05);
    });
});

describe('microfiche dimStopwords', () => {
    it('wraps stopwords in dim toggles and leaves content words alone', () => {
        expect(dimStopwords('the cat and the dog')).toBe(
            `${DIM_ON}the${DIM_OFF} cat ${DIM_ON}and${DIM_OFF} ${DIM_ON}the${DIM_OFF} dog`,
        );
    });

    it('leaves already-dim spans untouched', () => {
        expect(dimStopwords(`${DIM_ON}already dim${DIM_OFF} the`)).toBe(
            `${DIM_ON}already dim${DIM_OFF} ${DIM_ON}the${DIM_OFF}`,
        );
    });
});

describe('microfiche resolveMicroficheShape', () => {
    it('reads only the explicit render knobs', () => {
        expect(resolveMicroficheShape(GEMINI_KNOBS)).toEqual({
            font: '8x8',
            cellWidth: 8,
            cellHeight: 22,
            stretch: false,
            variant: 'bw',
            stopwordDim: false,
            columns: 1,
            lineRepeat: 1,
            frameSize: 2048,
        });
    });

    it('ignores preset selectors, caps, and keep-raw counts', () => {
        const shape = resolveMicroficheShape({
            ...GEMINI_KNOBS,
            microficheGeometry: 'glm',
            microficheModelName: 'some-model',
            microficheKeepRaw: 0,
            microficheImageCap: 0,
        });
        expect(shape).toEqual(resolveMicroficheShape(GEMINI_KNOBS));
    });

    it('passes custom knob values through untouched', () => {
        const shape = resolveMicroficheShape({
            microficheFont: '8x13',
            microficheCellWidth: 11,
            microficheCellHeight: 16,
            microficheStretch: false,
            microficheVariant: 'sent',
            microficheStopwordDim: true,
            microficheColumns: 2,
            microficheLineRepeat: 2,
            microficheFrameSize: 1568,
        });
        expect(shape).toEqual({
            font: '8x13',
            cellWidth: 11,
            cellHeight: 16,
            stretch: false,
            variant: 'sent',
            stopwordDim: true,
            columns: 2,
            lineRepeat: 2,
            frameSize: 1568,
        });
    });
});

describe('microfiche geometry', () => {
    it('computes grid capacity for one column', () => {
        expect(geometry(geminiShape(), 2048)).toEqual({ cols: 256, rows: 93, capacity: 23808 });
    });

    it('splits two columns around a 3-cell gutter', () => {
        expect(geometry(geminiShape({ columns: 2 }), 2048)).toEqual({
            cols: 126,
            rows: 93,
            capacity: 23436,
        });
    });

    it('divides rows by the line repeat', () => {
        expect(geometry(geminiShape({ lineRepeat: 2 }), 2048)).toEqual({
            cols: 256,
            rows: 46,
            capacity: 11776,
        });
    });
});

describe('microfiche splitKeepRaw', () => {
    it('keeps the newest K texts raw and sends the oldest to images', () => {
        expect(splitKeepRaw(['a', 'b', 'c', 'd'], 2)).toEqual({
            imageTexts: ['a', 'b'],
            rawTexts: ['c', 'd'],
        });
    });

    it('sends everything to images when keepRaw is 0', () => {
        expect(splitKeepRaw(['a', 'b'], 0)).toEqual({ imageTexts: ['a', 'b'], rawTexts: [] });
    });

    it('keeps everything raw when keepRaw covers the input', () => {
        expect(splitKeepRaw(['a', 'b'], 2)).toEqual({ imageTexts: [], rawTexts: ['a', 'b'] });
        expect(splitKeepRaw(['a', 'b'], 9)).toEqual({ imageTexts: [], rawTexts: ['a', 'b'] });
    });

    it('handles empty input', () => {
        expect(splitKeepRaw([], 2)).toEqual({ imageTexts: [], rawTexts: [] });
    });
});

describe('microfiche buildMicrofichePageTexts', () => {
    it('emits no image payloads, only page strings', () => {
        const result = buildMicrofichePageTexts(
            ['alpha one', 'beta two', 'gamma three'],
            geminiShape(),
            1,
        );
        expect(result.imageTexts.length).toBe(1);
        expect(typeof result.imageTexts[0]).toBe('string');
        expect(JSON.stringify(result)).not.toContain('data:image');
        expect(JSON.stringify(result)).not.toContain('base64');
    });

    it('keeps chronological order with the newest text raw', () => {
        const result = buildMicrofichePageTexts(
            ['alpha one', 'beta two', 'gamma three'],
            geminiShape(),
            1,
        );
        const joined = result.imageTexts.join('\n');
        expect(joined.indexOf('alpha')).toBeLessThan(joined.indexOf('beta'));
        expect(result.rawTexts).toEqual(['gamma three']);
    });

    it('paginates grid pages as contiguous substrings of the normalized input', () => {
        const shape = geminiShape({ frameSize: 64 });
        const input = 'word '.repeat(500);
        const normalized = normalize(input, { font: shape.font });
        const result = buildMicrofichePageTexts([input], shape, 0);
        expect(result.imageTexts.length).toBeGreaterThan(1);
        expect(result.imageTexts.join('')).toBe(normalized);
        const geo = geometry(shape, shape.frameSize);
        for (const page of result.imageTexts) {
            expect(page.length).toBeLessThanOrEqual(geo.capacity);
        }
    });

    it('yields no pages for whitespace-only input', () => {
        expect(buildMicrofichePageTexts(['   '], geminiShape(), 0)).toEqual({
            imageTexts: [],
            rawTexts: [],
        });
    });

    it('wraps two newspaper columns within the per-page line budget', () => {
        const shape = geminiShape({ columns: 2, frameSize: 64 });
        const geo = geometry(shape, shape.frameSize);
        const result = buildMicrofichePageTexts(['X a b c d e f', 'Y g h i j k l'], shape, 0);
        expect(result.imageTexts.length).toBeGreaterThan(0);
        for (const page of result.imageTexts) {
            expect(page.split('\n').length).toBeLessThanOrEqual(2 * geo.rows);
        }
        const joined = stripDimMarkers(result.imageTexts.join('\n'));
        expect(joined.indexOf('X')).toBeLessThan(joined.indexOf('Y'));
    });

    it('dims stopwords after pagination when the shape asks for it', () => {
        const result = buildMicrofichePageTexts(
            ['the cat sat'],
            geminiShape({ stopwordDim: true }),
            0,
        );
        expect(result.imageTexts[0]).toContain(`${DIM_ON}the${DIM_OFF}`);
    });

    it('smokes the full variant key set without throwing and keeps order', () => {
        const texts = ['A one two three', 'B four five six'];
        for (const font of ['5x8', '8x8', '6x12', '8x13', 'silver']) {
            for (const variant of ['bw', 'sent']) {
                for (const stopwordDim of [false, true]) {
                    for (const columns of [1, 2]) {
                        for (const lineRepeat of [1, 2]) {
                            for (const frameSize of [1568, 2048]) {
                                const shape = geminiShape({
                                    font,
                                    variant,
                                    stopwordDim,
                                    columns,
                                    lineRepeat,
                                    frameSize,
                                });
                                const result = buildMicrofichePageTexts(texts, shape, 0);
                                expect(result.imageTexts.length).toBeGreaterThan(0);
                                const joined = stripDimMarkers(result.imageTexts.join('\n'));
                                expect(joined.indexOf('A')).toBeLessThan(joined.indexOf('B'));
                            }
                        }
                    }
                }
            }
        }
    });
});

describe('microfiche renderer host freedom', () => {
    it('runs with no document or canvas in scope', () => {
        expect(typeof document).toBe('undefined');
        expect(normalize('host-free check')).toBe('host-free check');
    });
});
