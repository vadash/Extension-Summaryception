import { describe, expect, it } from 'vitest';

import { normalizeStructuralHeaderLines } from '../src/core/structural-headers.js';

describe('normalizeStructuralHeaderLines', () => {
    it.each([
        [null, ''],
        [undefined, ''],
        [12345, '12345'],
    ])('coerces non-string input %s to a string', (input, expected) => {
        expect(normalizeStructuralHeaderLines(input)).toBe(expected);
    });

    it('returns text without structural markers unchanged', () => {
        const text = 'just some prose with no markers';
        expect(normalizeStructuralHeaderLines(text)).toBe(text);
    });

    it('normalizes legacy line-start [NARRATIVE] headers to lowercased tags', () => {
        const result = normalizeStructuralHeaderLines('  [narrative]\nfoo');
        expect(result).toContain('<narrative>');
        expect(result).toContain('<narrative>\nfoo');
        expect(result).not.toContain('<narrative>\n\nfoo');
    });

    it('lowercases a line-start narrative open tag onto its own line', () => {
        const result = normalizeStructuralHeaderLines('  <NARRATIVE>\nfoo');
        expect(result).toContain('<narrative>');
        expect(result).toContain('<narrative>\nfoo');
        expect(result).not.toContain('<narrative>\n\nfoo');
    });

    it('lowercases a line-start narrative close tag onto its own line', () => {
        const result = normalizeStructuralHeaderLines('prose\n</NARRATIVE> trailing');
        expect(result).toContain('</narrative>');
        expect(result).toContain('</narrative>\ntrailing');
    });

    it('leaves inline mid-sentence tags alone', () => {
        const text = 'she wrote <narrative> on the board';
        expect(normalizeStructuralHeaderLines(text)).toBe(text);
    });

    it('lowercases a line-start declined marker onto its own line as one unit', () => {
        const result = normalizeStructuralHeaderLines('  <DECLINED>cannot summarize</DECLINED>');
        expect(result).toBe('<declined>cannot summarize</declined>');
    });
});
