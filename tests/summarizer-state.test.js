import { describe, expect, it } from 'vitest';
import {
    compileGlobalState,
    hasStateSection,
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

    it('detects only explicit state sections', () => {
        expect(hasStateSection('[NARRATIVE]\nScene.\n\n[STATE]\nlocation: dock')).toBe(true);
        expect(hasStateSection('Scene.\nlocation: dock')).toBe(false);
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

    it('generically caps long semicolon-delimited state lists during merge', () => {
        const counters = Array.from(
            { length: 12 },
            (_value, index) => `debt${index}: owed ${index}`,
        );

        expect(
            mergeStates([
                {
                    counters: ['old tally: 1', 'active score: 4'].join('; '),
                    inventory: 'badge; expired pass; map; closed case; lantern',
                },
                { counters: counters.join('; ') },
            ]),
        ).toEqual({
            counters: counters.slice(2).join('; '),
            inventory: 'badge; expired pass; map; closed case; lantern',
        });
    });

    it('preserves stale-sounding entries unless the whole value is an exact nullifier', () => {
        expect(
            mergeStates([
                { inventory: 'badge; map', counters: 'active score: 4' },
                { inventory: 'expired pass; closed case', counters: 'old tally: 1' },
            ]),
        ).toEqual({
            inventory: 'expired pass; closed case',
        });

        expect(mergeStates([{ inventory: 'badge; map' }, { inventory: 'removed' }])).toEqual({});
    });

    it('compiles global state from Layer 0 only', () => {
        expect(
            compileGlobalState([
                [{ text: '[NARRATIVE]\nRecent.\n[STATE]\nlocation: bridge\nhooks: none' }],
                [{ text: '[NARRATIVE]\nOlder.\n[STATE]\nplace: tower\nhooks: open gate' }],
            ]),
        ).toEqual({
            location: 'bridge',
        });
    });

    it('filters static profile facts from compiled current state', () => {
        expect(
            compileGlobalState([
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'They compared backgrounds.',
                            '[STATE]',
                            'zoe_origin_claim: grandmother from Chongju',
                            'vova_hometown: Moscow',
                            'vova_age: 32',
                            'zoe_species: human',
                            'dynamics: allied',
                        ].join('\n'),
                    },
                ],
            ]),
        ).toEqual({
            dynamics: 'allied',
        });
    });

    it('ignores state from deep layers', () => {
        expect(
            compileGlobalState([
                [],
                [],
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'Old scene.',
                            '[STATE]',
                            'location: tower',
                            'characters: Zoe: tired',
                            'zoe_wearing: pink robe',
                            'current_task: shower',
                            'hooks: find the gate',
                            'inventory: brass key',
                            'dynamics: wary alliance',
                        ].join('\n'),
                    },
                ],
            ]),
        ).toEqual({});
    });

    it('preserves recent transient keys from L0', () => {
        expect(
            compileGlobalState([
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'Recent setup.',
                            '[STATE]',
                            'location: bridge',
                            'vova_wearing: cloak',
                            'current_task: escape',
                        ].join('\n'),
                    },
                ],
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'Older setup.',
                            '[STATE]',
                            'location: tower',
                            'vova_wearing: robe',
                        ].join('\n'),
                    },
                ],
            ]),
        ).toEqual({
            location: 'bridge',
            vova_wearing: 'cloak',
            current_task: 'escape',
        });
    });

    it('lets recent nullifiers delete older tracked state', () => {
        expect(
            compileGlobalState([
                [{ text: '[NARRATIVE]\nRecent.\n[STATE]\nlocation: none' }],
                [],
                [{ text: '[NARRATIVE]\nOlder.\n[STATE]\nlocation: tower\nhooks: open gate' }],
            ]),
        ).toEqual({});
    });

    it('merges composite sub-entries without losing unmentioned older entries', () => {
        expect(
            mergeStates([
                { characters: 'Zoe: sore from exercise; Vova: tired' },
                { characters: 'Zoe: rested' },
            ]),
        ).toEqual({
            characters: 'Zoe: rested; Vova: tired',
        });
    });

    it('removes only the matching composite sub-entry on sub-entry nullifier', () => {
        expect(
            mergeStates([
                { characters: 'Alice: alert; Bob: injured' },
                { characters: 'Bob: removed' },
            ]),
        ).toEqual({
            characters: 'Alice: alert',
        });
    });

    it('falls back to whole-value overwrite for ambiguous composite values', () => {
        expect(
            mergeStates([{ inventory: 'badge; map; lantern' }, { inventory: 'map: none' }]),
        ).toEqual({
            inventory: 'map: none',
        });

        expect(
            mergeStates([{ inventory: 'badge; map' }, { inventory: 'a note with no colons here' }]),
        ).toEqual({
            inventory: 'a note with no colons here',
        });
    });

    it('preserves composite merge behavior within Layer 0', () => {
        expect(
            compileGlobalState([
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'Recent L0.',
                            '[STATE]',
                            'characters: Zoe: rested',
                        ].join('\n'),
                    },
                    {
                        text: [
                            '[NARRATIVE]',
                            'Newer L0.',
                            '[STATE]',
                            'characters: Vova: tired',
                            'hooks: open gate',
                        ].join('\n'),
                    },
                ],
            ]),
        ).toEqual({
            characters: 'Zoe: rested; Vova: tired',
            hooks: 'open gate',
        });
    });

    it('parses current_date_time while discarding start/end timeline fields', () => {
        expect(
            compileGlobalState([
                [
                    {
                        text: [
                            '[NARRATIVE]',
                            'Friday setup.',
                            '[STATE]',
                            'current_date_time: 2024-12-06 21 Fri',
                            'timeline_start: 2024-12-06 20 Fri',
                            'timeline_end: 2024-12-06 21 Fri',
                        ].join('\n'),
                    },
                    {
                        text: [
                            '[NARRATIVE]',
                            'Sunday continuation.',
                            '[STATE]',
                            'current_date_time: 2024-12-08 10 Sun',
                            'timeline_start: unknown',
                            'timeline_end: unknown',
                        ].join('\n'),
                    },
                ],
            ]),
        ).toEqual({
            current_date_time: '2024-12-08 10 Sun',
        });
    });

    it('prunes ephemeral counters while preserving unresolved obligation counters', () => {
        expect(
            mergeStates([
                {
                    hooks: 'red ledger: pending settlement',
                    counters: [
                        'arousal: 4',
                        'coffee cups: 2',
                        'red ledger: 2',
                        'rent debt: owed',
                    ].join('; '),
                },
            ]),
        ).toEqual({
            hooks: 'red ledger: pending settlement',
            counters: 'red ledger: 2; rent debt: owed',
        });
    });

    it('merges named hook entries independently', () => {
        expect(
            mergeStates([
                { hooks: 'appointment: pending Friday; gate: open' },
                { hooks: 'appointment: resolved; debt: owed tonight' },
            ]),
        ).toEqual({
            hooks: 'gate: open; debt: owed tonight',
        });
    });
});
