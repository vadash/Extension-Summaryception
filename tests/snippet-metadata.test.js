import { describe, expect, it } from 'vitest';

import {
    buildPromotedSnippetMetadata,
    buildSnippetMetadataFromText,
    extractSnippetMetadata,
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
    getSnippetDisplayMeta,
    parseSnippet,
} from '../src/core/snippet-metadata.js';
import { installSummaryContext, makeMessages } from './test-helpers.js';

describe('extractSnippetMetadata', () => {
    it('extracts source IDs and a known datetime', () => {
        expect(
            extractSnippetMetadata({
                sourceMessageIds: ['a', 'b'],
                currentDateTime: '2024-01-02 14',
            }),
        ).toEqual({ sourceMessageIds: ['a', 'b'], currentDateTime: '2024-01-02 14' });
    });

    it.each(['unknown', 'UNKNOWN', ''])('drops placeholder datetime (%s)', (currentDateTime) => {
        expect(
            extractSnippetMetadata({ sourceMessageIds: ['a'], currentDateTime }),
        ).not.toHaveProperty('currentDateTime');
    });
});

describe('buildPromotedSnippetMetadata', () => {
    it('unions source IDs in child order', () => {
        expect(
            buildPromotedSnippetMetadata([
                { sourceMessageIds: ['a', 'b'] },
                { sourceMessageIds: ['b', 'c'] },
            ]).sourceMessageIds,
        ).toEqual(['a', 'b', 'c']);
    });

    it('takes the last known datetime', () => {
        expect(
            buildPromotedSnippetMetadata([
                { currentDateTime: '2024-01-01 09' },
                { currentDateTime: '2024-01-03 20' },
            ]).currentDateTime,
        ).toBe('2024-01-03 20');
    });
});

describe('live metadata anchors', () => {
    it('resolves source IDs to current indices', () => {
        installSummaryContext({ chat: makeMessages(8) });
        const snippet = {
            sourceMessageIds: ['message-2', 'message-7'],
            currentDateTime: '2024-01-02 14',
        };

        expect(formatSnippetAnchor(snippet)).toBe('[msgs 2-7; current 2024-01-02 14]');
        expect(formatCompactSnippetAnchor(snippet)).toBe('[2-7@2024-01-02T14]');
    });

    it('omits anchors when no source ID resolves', () => {
        installSummaryContext({ chat: makeMessages(1) });
        expect(formatSnippetAnchor({ sourceMessageIds: ['missing'] })).toBe('');
    });
});

describe('getSnippetDisplayMeta', () => {
    it('derives counts from a source snippet', () => {
        expect(getSnippetDisplayMeta({ sourceMessageIds: ['a', 'b', 'c'] })).toEqual({
            sourceCount: 3,
            mergedCount: 0,
            fromLayer: undefined,
            promoted: false,
        });
    });

    it('derives merge provenance and promotion from a merged snippet', () => {
        expect(getSnippetDisplayMeta({ mergedCount: 4, fromLayer: 1, promoted: 1 })).toEqual({
            sourceCount: 0,
            mergedCount: 4,
            fromLayer: 1,
            promoted: true,
        });
    });

    it('derives safe defaults from a bare snippet', () => {
        expect(getSnippetDisplayMeta({})).toEqual({
            sourceCount: 0,
            mergedCount: 0,
            fromLayer: undefined,
            promoted: false,
        });
    });
});

describe('parseSnippet', () => {
    it('strips the [NARRATIVE] header and extracts the scene-time key line', () => {
        const parsed = parseSnippet('[NARRATIVE]\nScene.\n\ncurrent_date_time: 2024-07-04 16 Thu');
        expect(parsed.narrative).toBe('Scene.');
        expect(parsed.currentDateTime).toBe('2024-07-04 16 Thu');
    });

    it('corrects a hallucinated weekday against the ISO date', () => {
        const parsed = parseSnippet('[NARRATIVE]\nScene.\n\ncurrent_date_time: 2024-12-03 06 Fri');
        expect(parsed.currentDateTime).toBe('2024-12-03 06 Tue');
    });

    it('inserts the weekday when the model omitted it', () => {
        const parsed = parseSnippet('[NARRATIVE]\nScene.\n\ncurrent_date_time: 2024-07-07 06');
        expect(parsed.currentDateTime).toBe('2024-07-07 06 Sun');
    });

    it('drops stray minutes and re-derives the weekday', () => {
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\ncurrent_date_time: 2024-07-04 16:32 Wed',
        );
        expect(parsed.currentDateTime).toBe('2024-07-04 16 Thu');
    });

    it.each(['someday soon', '2024-02-30 06 Sat', 'Feb 30, 2024 03 06'])(
        'leaves malformed scene times untouched rather than fabricating (%s)',
        (value) => {
            const parsed = parseSnippet(`[NARRATIVE]\nScene.\n\ncurrent_date_time: ${value}`);
            expect(parsed.currentDateTime).toBe(value);
        },
    );

    it('keeps the whole text as narrative when no scene-time key line exists', () => {
        const parsed = parseSnippet('Plain prose without any headers.');
        expect(parsed.narrative).toBe('Plain prose without any headers.');
        expect(parsed.currentDateTime).toBeUndefined();
    });

    it('returns an empty narrative for empty input', () => {
        expect(parseSnippet('')).toEqual({ narrative: '', currentDateTime: undefined });
        expect(parseSnippet('   ')).toEqual({ narrative: '', currentDateTime: undefined });
    });
});

describe('buildSnippetMetadataFromText', () => {
    it('extracts the normalized scene time from a snippet', () => {
        expect(
            buildSnippetMetadataFromText(
                '[NARRATIVE]\nScene.\n\ncurrent_date_time: 2024-12-03 06 Fri',
            ),
        ).toEqual({ currentDateTime: '2024-12-03 06 Tue' });
    });

    it('omits currentDateTime when the text carries no scene time', () => {
        expect(buildSnippetMetadataFromText('[NARRATIVE]\nScene.')).toEqual({});
    });
});
