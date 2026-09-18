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

    it('uppercases a line-start marker and separates the following line by exactly one newline', () => {
        const result = normalizeStructuralHeaderLines('  [narrative]\nfoo');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('[NARRATIVE]\nfoo');
        expect(result).not.toContain('[NARRATIVE]\n\nfoo');
    });
});
