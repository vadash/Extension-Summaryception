import { describe, it, expect, vi } from 'vitest';

// Mock state so prompts.js can call getSettings() without a live runtime.
const getSettingsMock = vi.fn(() => ({ stripPatterns: ['<thinking>', '</thinking>'] }));

vi.mock('../src/foundation/state.js', () => ({
    getSettings: () => getSettingsMock(),
    getEffectiveSettings: () => getSettingsMock(),
}));

function setStripPatterns(patterns) {
    getSettingsMock.mockReturnValue({ stripPatterns: patterns });
}

import {
    applyChineseOutputPolicy,
    cleanSummarizerOutput,
    getChineseIdeographStats,
    stripChineseIdeographs,
    validateSummarizerOutputIntegrity,
} from '../src/core/prompts.js';

describe('cleanSummarizerOutput', () => {
    it('removes configured strip patterns (destroys tags, leaving inner text)', () => {
        setStripPatterns(['<thinking>', '</thinking>']);
        const raw = 'pre <thinking>secret</thinking> post';
        expect(cleanSummarizerOutput(raw)).toBe('pre secret post');
    });

    it('strips full thinking blocks when tags were not pre-stripped', () => {
        setStripPatterns([]);
        const raw = '<thinking>I should be hidden</thinking>Answer: 42';
        const result = cleanSummarizerOutput(raw);
        expect(result.toLowerCase()).not.toContain('i should be hidden');
        expect(result).toContain('42');
    });

    it('handles output wrappers and structural markers', () => {
        expect(cleanSummarizerOutput('<output>Final answer.</output>')).toBe('Final answer.');

        const structuralOutput = '[NARRATIVE]\nScene summary.\n\n[STATE]\nlocation: dock';
        expect(cleanSummarizerOutput(structuralOutput)).toBe(structuralOutput);
        expect(
            cleanSummarizerOutput('[NARRATIVE]\nMerged summary.\n[STATE]', {
                stripStructuralMarkers: true,
            }),
        ).toBe('Merged summary.');
    });

    it('canonicalizes inline structural headers before validation/storage', () => {
        expect(
            cleanSummarizerOutput(
                '[NARRATIVE] Scene summary. [STATE] current_date_time: 2026-07-09 02 Thu',
            ),
        ).toBe(
            [
                '[NARRATIVE]',
                'Scene summary.',
                '[STATE]',
                'current_date_time: 2026-07-09 02 Thu',
            ].join('\n'),
        );
    });

    it('removes multiple reasoning-tag variants', () => {
        const raw = [
            '<reasoning>scratch</reasoning>',
            '<thought>idea</thought>',
            '<reflect>meta</reflect>',
            '<inner_monologue>whisper</inner_monologue>',
            'VALID OUTPUT',
        ].join('\n');
        const cleaned = cleanSummarizerOutput(raw);
        expect(cleaned).toContain('VALID OUTPUT');
        expect(cleaned).not.toContain('scratch');
        expect(cleaned).not.toContain('idea');
        expect(cleaned).not.toContain('meta');
        expect(cleaned).not.toContain('whisper');
    });

    it('normalizes excess whitespace', () => {
        expect(cleanSummarizerOutput('alpha\n\n\n\n\nbeta')).toBe('alpha\nbeta');
        expect(cleanSummarizerOutput('\n\nhello\n\n')).toBe('hello');
    });
});

it('invokes effective settings to read strip patterns', () => {
    getSettingsMock.mockClear();
    setStripPatterns([]);
    cleanSummarizerOutput('test');
    expect(getSettingsMock).toHaveBeenCalled();
});

it('counts Chinese ideographs against visible non-whitespace characters', () => {
    expect(getChineseIdeographStats('漢 abc def ghi')).toEqual({
        chineseIdeographs: 1,
        visibleCharacters: 10,
        ratio: 0.1,
    });
});

it('strips Chinese ideographs without removing Latin text', () => {
    expect(stripChineseIdeographs('alpha 漢字 beta')).toBe('alpha  beta');
});

describe('applyChineseOutputPolicy', () => {
    it('does nothing when stripping is disabled', () => {
        expect(
            applyChineseOutputPolicy('漢字 summary', {
                stripChineseIdeographs: false,
            }),
        ).toEqual({
            text: '漢字 summary',
            error: null,
            percent: null,
        });
    });

    it('rejects output above ten percent Chinese ideographs as retryable', () => {
        const result = applyChineseOutputPolicy('漢字漢字漢字 ok', {
            stripChineseIdeographs: true,
        });

        expect(result.text).toBe('');
        expect(result.percent).toBe('75.0');
        expect(result.error?.message).toBe('CN ideograph ratio 75.0% exceeds 10%');
        expect(result.error?.retryable).toBe(true);
    });

    it('strips Chinese ideographs at exactly ten percent', () => {
        expect(
            applyChineseOutputPolicy('漢abcdefghi', {
                stripChineseIdeographs: true,
            }),
        ).toEqual({
            text: 'abcdefghi',
            error: null,
            percent: null,
        });
    });
});

describe('validateSummarizerOutputIntegrity', () => {
    it('rejects tiny outputs for substantial source text', () => {
        const result = validateSummarizerOutputIntegrity('[Nivalis]', {
            kind: 'promotion',
            memoryTokensBefore: 900,
        });

        expect(result.valid).toBe(false);
        expect(result.error?.message).toContain('output too short');
        expect(result.error?.retryable).toBe(true);
    });

    it('requires non-empty L0 narrative and state sections', () => {
        expect(
            validateSummarizerOutputIntegrity('A summary without headers.', {
                kind: 'layer0',
                regexStats: { finalTokens: 120 },
            }).valid,
        ).toBe(false);
        expect(
            validateSummarizerOutputIntegrity('[NARRATIVE]\nScene summary.\n\n[STATE]', {
                kind: 'regenerate',
                regexStats: { finalTokens: 120 },
            }).valid,
        ).toBe(false);
    });

    it('accepts a structured L0 output above the safety floor', () => {
        const output = [
            '[NARRATIVE]',
            'The group reviewed the plan, crossed the bridge, and secured the gate before nightfall.',
            '',
            '[STATE]',
            'current_date_time: 2024-12-03 21 Tue',
        ].join('\n');

        expect(
            validateSummarizerOutputIntegrity(output, {
                kind: 'layer0',
                regexStats: { finalTokens: 120 },
            }),
        ).toEqual({ valid: true, error: null });
    });

    it('accepts L0 output with inline structural markers after cleanup', () => {
        const output =
            '[NARRATIVE] The group reviewed the plan, crossed the bridge, and secured the gate before nightfall. [STATE] current_date_time: 2026-07-09 02 Thu';

        const cleaned = cleanSummarizerOutput(output);

        expect(
            validateSummarizerOutputIntegrity(cleaned, {
                kind: 'layer0',
                regexStats: { finalTokens: 120 },
            }),
        ).toEqual({ valid: true, error: null });
    });
});
