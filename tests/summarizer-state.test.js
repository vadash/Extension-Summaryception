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

    it('recovers a trailing state block when structural markers were stripped', () => {
        const parsed = parseSnippet(
            [
                'They reached the tower and secured the door.',
                'location: tower',
                'characters: Alice: alert, Bob: injured',
                'hooks: open gate',
            ].join('\n'),
        );

        expect(parsed).toEqual({
            narrative: 'They reached the tower and secured the door.',
            state: {
                location: 'tower',
                characters: 'Alice: alert, Bob: injured',
                hooks: 'open gate',
            },
        });
    });

    it('recovers a single known state line after narrative text', () => {
        const parsed = parseSnippet('They reached the dock.\nlocation: dock');

        expect(parsed).toEqual({
            narrative: 'They reached the dock.',
            state: {
                location: 'dock',
            },
        });
    });

    it('does not treat dialogue-only legacy text as implicit state', () => {
        const text = 'Alice: Hold the door.\nBob: I have it.';

        expect(parseSnippet(text)).toEqual({
            narrative: text,
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

    it('escapes raw double quotes when serializing state values', () => {
        expect(
            serializeState({
                hooks: 'caption "ready", note \\"already escaped\\"',
            }),
        ).toBe(['[STATE]', 'hooks: caption \\"ready\\", note \\"already escaped\\"'].join('\n'));
    });

    it('strips balanced pseudo-object braces from serialized state values', () => {
        expect(
            serializeState({
                characters: '{Alice: alert, Bob: injured}',
                inventory: '{key: brass}',
            }),
        ).toBe(
            ['[STATE]', 'characters: Alice: alert, Bob: injured', 'inventory: key: brass'].join(
                '\n',
            ),
        );
    });

    it('prunes stale list entries and caps long counter lists during merge', () => {
        const counters = Array.from({ length: 10 }, (_value, index) => `count${index}: ${index}`);

        expect(
            mergeStates([
                {
                    counters: [
                        'old tally: 1',
                        'current tally: 2',
                        'previous score: 3',
                        'active score: 4',
                    ].join('; '),
                    inventory: 'badge; expired pass; map; closed case; lantern',
                },
                { counters: counters.join('; ') },
            ]),
        ).toEqual({
            counters: counters.slice(2).join('; '),
            inventory: 'badge; map; lantern',
        });
    });

    it('preserves prior state when pruning removes every incoming list entry', () => {
        expect(
            mergeStates([
                { inventory: 'badge; map', counters: 'active score: 4' },
                { inventory: 'expired pass; closed case', counters: 'old tally: 1' },
            ]),
        ).toEqual({
            inventory: 'badge; map',
            counters: 'active score: 4',
        });
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
