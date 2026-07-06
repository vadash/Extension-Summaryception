import { describe, expect, it } from 'vitest';
import {
    compileGlobalState,
    mergeStates,
    parseSnippet,
    serializeState,
} from '../src/core/summarizer-state.js';

describe('summarizer-state', () => {
    it('parses dual-track snippets with normalized state keys', () => {
        const parsed = parseSnippet(
            [
                '[NARRATIVE]',
                'They reached the tower.',
                '',
                '[STATE]',
                '- current location: tower',
                '* Items = brass key',
                'relationship - allied',
            ].join('\n'),
        );

        expect(parsed).toEqual({
            narrative: 'They reached the tower.',
            state: {
                location: 'tower',
                inventory: 'brass key',
                dynamics: 'allied',
            },
        });
    });

    it('falls back to narrative-only when no state block exists', () => {
        expect(parseSnippet('Plain legacy summary.')).toEqual({
            narrative: 'Plain legacy summary.',
            state: {},
        });
    });

    it('captures malformed state lines as capped unclassified notes', () => {
        const parsed = parseSnippet(
            [
                '[NARRATIVE]',
                'Scene.',
                '[STATE]',
                'first note',
                'second note',
                'third note',
                'fourth note',
            ].join('\n'),
        );

        expect(parsed.state).toEqual({
            unclassified_notes: 'first note; second note; third note [...]',
        });
    });

    it('merges later values by overwrite and deletes explicit null values', () => {
        expect(
            mergeStates([
                { location: 'tower', hooks: 'open gate', inventory: 'key' },
                { place: 'dock', hooks: 'resolved' },
            ]),
        ).toEqual({
            location: 'dock',
            inventory: 'key',
        });
    });

    it('dedupes and caps unclassified notes across merges', () => {
        expect(
            mergeStates([
                { unclassified_notes: 'first; second; third [...]' },
                { unclassified_notes: 'second; fourth' },
            ]),
        ).toEqual({
            unclassified_notes: 'first; second; third [...]',
        });
    });

    it('serializes non-empty non-null state values', () => {
        expect(
            serializeState({
                location: 'dock',
                hooks: 'none',
                inventory: '',
                counters: 'lock: 2',
            }),
        ).toBe(['[STATE]', 'location: dock', 'counters: lock: 2'].join('\n'));
    });

    it('compiles global state oldest to newest across layers', () => {
        expect(
            compileGlobalState([
                [{ text: '[NARRATIVE]\nRecent.\n[STATE]\nlocation: bridge\nhooks: none' }],
                [{ text: '[NARRATIVE]\nOlder.\n[STATE]\nplace: tower\nhooks: open gate' }],
            ]),
        ).toEqual({
            location: 'bridge',
        });
    });
});
