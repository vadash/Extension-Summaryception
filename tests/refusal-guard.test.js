import { describe, expect, it } from 'vitest';

import {
    buildPassageNameCensus,
    extractDeclinedReason,
    findPassageShapeRefusal,
    findRefusalPattern,
} from '../src/core/refusal-guard.js';

describe('extractDeclinedReason', () => {
    it('reads the reason out of a declined marker', () => {
        expect(extractDeclinedReason('<declined>explicit sexual content</declined>')).toBe(
            'explicit sexual content',
        );
    });

    it('reads a declined marker with surrounding whitespace', () => {
        expect(extractDeclinedReason('\n<declined>  policy limits  </declined>\n')).toBe(
            'policy limits',
        );
    });

    it('returns an empty-string reason for a bare declined marker', () => {
        expect(extractDeclinedReason('<declined></declined>')).toBe('');
    });

    it('returns null for output without a declined marker', () => {
        expect(extractDeclinedReason('<narrative>Scene.</narrative>')).toBeNull();
        expect(extractDeclinedReason('')).toBeNull();
    });

    it('returns null when the declined marker is only mentioned mid-prose', () => {
        expect(
            extractDeclinedReason('<narrative>He wrote <declined> on the board.</narrative>'),
        ).toBeNull();
    });
});

describe('findRefusalPattern', () => {
    it.each([
        ["I can't summarize this passage.", 'inability'],
        ['I am unable to rewrite material like that.', 'inability'],
        ["I won't process this request.", 'inability'],
        ['I can offer help with a different project instead.', 'deflection'],
        ['This violates my content policy.', 'policy'],
        ['The passage contains explicit sexual content.', 'policy'],
        ['As an AI language model, I cannot do that.', 'identity'],
    ])('flags a refusal: %s', (body) => {
        expect(findRefusalPattern(body)).not.toBeNull();
    });

    it.each([
        'She ruled that a brother never wakes a sleeping sister.',
        'He kept his arousal hidden the whole time; she never noticed.',
        'Quipsy priced ear kneading as a premium service payable in desserts.',
    ])('keeps in-story prose inert: %s', (body) => {
        expect(findRefusalPattern(body)).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(findRefusalPattern('')).toBeNull();
        expect(findRefusalPattern(null)).toBeNull();
    });
});

describe('buildPassageNameCensus', () => {
    const passage = [
        'Quipsy greeted Vova with a hug. Quipsy claimed the room across from his.',
        'Vova bought vegetables and a juicer before Quipsy even arrived.',
        'Mom approved the trip. The mall was crowded that afternoon.',
    ].join(' ');

    it('ranks frequently named characters first and caps the census', () => {
        const census = buildPassageNameCensus(passage);
        expect(census[0]).toBe('Quipsy');
        expect(census).toContain('Vova');
        expect(census).not.toContain('Mom');
        expect(census.length).toBeLessThanOrEqual(8);
    });

    it('drops capitalized non-names and rare words', () => {
        const census = buildPassageNameCensus(passage);
        expect(census).not.toContain('The');
        expect(census).not.toContain('Mom');
        expect(census).not.toContain('Mall');
    });

    it('returns an empty census for empty input', () => {
        expect(buildPassageNameCensus('')).toEqual([]);
        expect(buildPassageNameCensus(null)).toEqual([]);
    });
});

describe('findPassageShapeRefusal', () => {
    const names = ['Quipsy', 'Vova'];

    it('flags a meta-description that names none of the passage names', () => {
        const body =
            'The passage contains several scenes of the two characters talking and shopping together.';
        expect(findPassageShapeRefusal(body, names)).toBe(true);
    });

    it('keeps a real summary that names a passage character', () => {
        const body = 'Quipsy moved in and claimed the room across from his.';
        expect(findPassageShapeRefusal(body, names)).toBe(false);
    });

    it('keeps a nameless narration when the census is empty', () => {
        expect(findPassageShapeRefusal('The passage continues.', [])).toBe(false);
    });

    it('keeps a nameless but concrete narration when no meta-reference appears', () => {
        expect(findPassageShapeRefusal('They shopped and laughed until dark.', names)).toBe(false);
    });

    it('flags a nameless body that only references the text itself', () => {
        expect(
            findPassageShapeRefusal(
                'The material describes a shopping trip and a movie night.',
                names,
            ),
        ).toBe(true);
    });
});
