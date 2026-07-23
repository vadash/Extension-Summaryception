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
    validateLayer0OutputSize,
    validateSummarizerOutputIntegrity,
} from '../src/core/prompts.js';
import { installSillyTavernStub } from './test-helpers.js';

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

describe('validateLayer0OutputSize', () => {
    it('accepts a narrative near miss below the repair ceiling without retry feedback', async () => {
        installSillyTavernStub({
            getTokenCountAsync: async (text) =>
                String(text || '')
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean).length,
        });
        const output = [
            '[NARRATIVE]',
            'durable '.repeat(310),
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
        ].join('\n');

        await expect(
            validateLayer0OutputSize(
                output,
                { layer0SummaryTokenTarget: 200 },
                { kind: 'layer0', sourceTokensBefore: 100 },
            ),
        ).resolves.toEqual({ valid: true, error: null, repairFeedback: '' });
    });

    it('compacts a state near miss locally before accepting it', async () => {
        installSillyTavernStub({
            getTokenCountAsync: async (text) =>
                String(text || '')
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean).length,
        });
        const output = [
            '[NARRATIVE]',
            'The party reached the bridge.',
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
            `hooks: ${'pending '.repeat(320)}`,
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0', sourceTokensBefore: 100 },
        );

        expect(result.valid).toBe(true);
        expect(result.text).toContain('[STATE]');
        expect(result.text.length).toBeLessThan(output.length);
        expect(result.text).toContain('current_date_time: 2026-07-09 02 Thu');
    });

    it('salvages a state overflow that trims under the hard maximum instead of rejecting', async () => {
        // Deterministic state compaction now runs without a magnitude gate, so a
        // state-only overflow that fits after trimming is accepted in-process
        // rather than forcing a full LLM repair retry.
        installSillyTavernStub({
            getTokenCountAsync: async (text) =>
                String(text || '')
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean).length,
        });
        const output = [
            '[NARRATIVE]',
            'The party reached the bridge.',
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
            `hooks: ${'pending '.repeat(400)}`,
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0', sourceTokensBefore: 100 },
        );

        expect(result.valid).toBe(true);
        expect(result.text).toContain('[STATE]');
        expect(result.text).toContain('current_date_time: 2026-07-09 02 Thu');
        expect(result.text.length).toBeLessThan(output.length);
    });

    it('rejects narrative-only overflow with draft-aware repair feedback', async () => {
        const output = [
            '[NARRATIVE]',
            'Verbose scene replay. '.repeat(160),
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0', sourceTokensBefore: 100 },
        );

        expect(result.valid).toBe(false);
        expect(result.error?.message).toContain('[NARRATIVE]');
        expect(result.error?.message).toContain('hard maximum 300');
        expect(result.error?.retryable).toBe(true);
        expect(result.diagnostics.violations.map((violation) => violation.id)).toEqual([
            'narrative',
        ]);
        expect(result.repairFeedback).toContain('<rejected_narrative>');
        expect(result.repairFeedback).toContain('Verbose scene replay.');
        expect(result.repairFeedback).toContain('reduce by');
        expect(result.repairFeedback).toContain('Preserve [STATE] unchanged');
        expect(result.repairFeedback).toContain('<preserve_state>');
    });

    it('rejects short Layer 0 outputs only for substantial source text', async () => {
        const output = [
            '[NARRATIVE]',
            'The party regrouped near the bridge and agreed to keep watch while the gate remained unsafe.',
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
        ].join('\n');

        await expect(
            validateLayer0OutputSize(
                output,
                { layer0SummaryTokenTarget: 200 },
                { kind: 'layer0', sourceTokensBefore: 900 },
            ),
        ).resolves.toMatchObject({
            valid: false,
            diagnostics: {
                violations: [expect.objectContaining({ id: 'narrative', reason: 'below-minimum' })],
            },
        });
        await expect(
            validateLayer0OutputSize(
                output,
                { layer0SummaryTokenTarget: 200 },
                { kind: 'layer0', sourceTokensBefore: 100 },
            ),
        ).resolves.toEqual({ valid: true, error: null, repairFeedback: '' });
    });

    it('salvages a state-only overflow while a passing narrative is preserved verbatim', async () => {
        const output = [
            '[NARRATIVE]',
            'The party reached the bridge.',
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
            `hooks: ${'pending '.repeat(400)}`,
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            { layer0SummaryTokenTarget: 500 },
            { kind: 'layer0', sourceTokensBefore: 100 },
        );

        // The passing narrative no longer needs a repair cycle, and the
        // overflowing state is deterministically trimmed in-process instead of
        // being pushed into an LLM retry.
        expect(result.valid).toBe(true);
        expect(result.text).toContain('[NARRATIVE]');
        expect(result.text).toContain('The party reached the bridge.');
        expect(result.text).toContain('[STATE]');
        expect(result.text).toContain('current_date_time: 2026-07-09 02 Thu');
        expect(result.text.length).toBeLessThan(output.length);
    });

    it('salvages state then rejects the remaining narrative violation while total size stays diagnostic', async () => {
        const output = [
            '[NARRATIVE]',
            'Verbose scene replay. '.repeat(160),
            '',
            '[STATE]',
            'current_date_time: 2026-07-09 02 Thu',
            `hooks: ${'pending '.repeat(400)}`,
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0', sourceTokensBefore: 100 },
        );

        // The state block is deterministically compacted on the first pass, so
        // only the genuinely-unrepairable narrative overflow reaches diagnostics.
        // The salvage path skips when any non-state violation is present, so a
        // narrative violation short-circuits straight to the repair feedback.
        expect(result.valid).toBe(false);
        expect(result.diagnostics.violations.map((violation) => violation.id)).toEqual([
            'narrative',
        ]);
        expect(result.error?.message).toContain('[NARRATIVE]');
        expect(result.repairFeedback).toContain('Total draft:');
        expect(result.repairFeedback).toContain('(diagnostic only)');
        expect(result.diagnostics.violations.some((v) => v.id === 'state')).toBe(false);
    });

    it('does not apply L0 size bounds to promotion outputs', async () => {
        await expect(
            validateLayer0OutputSize(
                'Verbose promotion. '.repeat(400),
                { layer0SummaryTokenTarget: 200 },
                { kind: 'promotion', memoryTokensBefore: 1000 },
            ),
        ).resolves.toEqual({ valid: true, error: null, repairFeedback: '' });
    });
});
