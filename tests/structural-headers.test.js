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

    it('uppercases a line-start [state] and breaks before its key:value content', () => {
        const result = normalizeStructuralHeaderLines('[state] key: v');
        expect(result).toContain('[STATE]');
        expect(result).toContain('[STATE]\nkey: v');
    });

    it('isolates an inline [STATE] followed by a key:value line onto its own line', () => {
        const result = normalizeStructuralHeaderLines('some text [STATE] key: value');
        expect(result).toContain('\n[STATE]\n');
    });

    it('normalizes every inline [STATE] occurrence globally', () => {
        const result = normalizeStructuralHeaderLines(
            'intro [STATE] alpha: 1 middle [STATE] beta: 2',
        );
        const matches = result.match(/\n\[STATE\]\n/g) || [];
        expect(matches.length).toBe(2);
    });
});
