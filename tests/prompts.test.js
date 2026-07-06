import { describe, it, expect, vi } from 'vitest';

// Mock state so prompts.js can call getSettings() without a live runtime.
const getSettingsMock = vi.fn(() => ({ stripPatterns: ['<thinking>', '</thinking>'] }));

vi.mock('../src/foundation/state.js', () => ({
    getSettings: () => getSettingsMock(),
}));

function setStripPatterns(patterns) {
    getSettingsMock.mockReturnValue({ stripPatterns: patterns });
}

import {
    cleanSummarizerOutput,
    getChineseIdeographStats,
    stripChineseIdeographs,
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

    it('keeps the content inside <output> tags', () => {
        const raw = '<output>Final answer.</output>';
        expect(cleanSummarizerOutput(raw)).toBe('Final answer.');
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

    it('collapses three or more consecutive newlines down to one', () => {
        const raw = 'alpha\n\n\n\n\nbeta';
        expect(cleanSummarizerOutput(raw)).toBe('alpha\nbeta');
    });

    it('trims surrounding whitespace', () => {
        expect(cleanSummarizerOutput('\n\nhello\n\n')).toBe('hello');
    });
});

it('invokes getSettings to read strip patterns', () => {
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
