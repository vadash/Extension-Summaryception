import { describe, expect, it } from 'vitest';

import { recoverContinuityJson } from '../src/core/parse-recovery.js';

describe('recoverContinuityJson', () => {
    it('returns tier 1 with the parsed value for clean JSON', () => {
        expect(recoverContinuityJson('{"turn_count": 42}')).toEqual({
            tier: 1,
            value: { turn_count: 42 },
        });
    });

    it('returns tier 1 for whitespace-padded JSON', () => {
        expect(recoverContinuityJson('  \n{"a": 1}\n  ')).toEqual({ tier: 1, value: { a: 1 } });
    });

    it('recovers JSON wrapped in a markdown code fence at tier 2', () => {
        expect(recoverContinuityJson('```json\n{"turn_count": 7}\n```')).toEqual({
            tier: 2,
            value: { turn_count: 7 },
        });
    });

    it('recovers an unclosed opening fence at tier 2', () => {
        expect(recoverContinuityJson('```json\n{"turn_count": 7}')).toEqual({
            tier: 2,
            value: { turn_count: 7 },
        });
    });

    it('recovers JSON with prose around the object at tier 2', () => {
        expect(
            recoverContinuityJson('Here is the state:\n{"turn_count": 7}\nHope it helps!'),
        ).toEqual({ tier: 2, value: { turn_count: 7 } });
    });

    it('recovers a fully smart-quoted object at tier 3', () => {
        expect(recoverContinuityJson('{“turn_count”: 7}')).toEqual({
            tier: 3,
            value: { turn_count: 7 },
        });
    });

    it('recovers mixed straight and smart quotes at tier 3', () => {
        expect(recoverContinuityJson('{"a": “smart”}')).toEqual({ tier: 3, value: { a: 'smart' } });
    });

    it('extracts the state object past prose braces at tier 5', () => {
        const text =
            'The {state} you asked for:\n' +
            '{"turn_count": 7, "gm_notes": ["[R] keep {braces} in strings"]}\n' +
            'Done.';
        expect(recoverContinuityJson(text)).toEqual({
            tier: 5,
            value: { turn_count: 7, gm_notes: ['[R] keep {braces} in strings'] },
        });
    });

    it('prefers the largest balanced block when trailing prose carries a brace', () => {
        expect(recoverContinuityJson('junk {"a": {"b": 1}} and then } weird')).toEqual({
            tier: 5,
            value: { a: { b: 1 } },
        });
    });

    it('ignores braces inside JSON strings when prose braces defeat the slice', () => {
        expect(recoverContinuityJson('{"a": "has } brace"} trailing }')).toEqual({
            tier: 5,
            value: { a: 'has } brace' },
        });
    });

    it('recovers a truncated root object that an inner balanced block would steal at tier 4', () => {
        expect(
            recoverContinuityJson(
                '{"turn_count": 7, "bonds": {}, "agendas": {}, "gm_notes": [], "physics": {"location"',
            ),
            // The dangling key gets a null value here; classification's
            // normalizers coerce it to the schema default ('' for physics).
        ).toEqual({
            tier: 4,
            value: {
                turn_count: 7,
                bonds: {},
                agendas: {},
                gm_notes: [],
                physics: { location: null },
            },
        });
    });

    it('strips a trailing comma before the outer close at tier 4', () => {
        expect(recoverContinuityJson('{"turn_count": 7, "gm_notes": ["[R] x"],}')).toEqual({
            tier: 4,
            value: { turn_count: 7, gm_notes: ['[R] x'] },
        });
    });

    it('completes missing object and array closes at tier 4', () => {
        expect(recoverContinuityJson('{"turn_count": 7, "physics": {"location": "Salon"')).toEqual({
            tier: 4,
            value: { turn_count: 7, physics: { location: 'Salon' } },
        });
    });

    it('completes a string cut off mid-value at tier 4', () => {
        expect(recoverContinuityJson('{"gm_notes": ["[R] cut off')).toEqual({
            tier: 4,
            value: { gm_notes: ['[R] cut off'] },
        });
    });

    it('returns null for text with no object or array at all', () => {
        expect(recoverContinuityJson('I cannot summarize this.')).toBeNull();
        expect(recoverContinuityJson('')).toBeNull();
        expect(recoverContinuityJson(null)).toBeNull();
    });
});
