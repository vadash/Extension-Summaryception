import { describe, it, expect, vi } from 'vitest';

// Mock state so prompts.js can call getSettings() without a live runtime.
const getSettingsMock = vi.fn(() => ({ stripPatterns: ['<thinking>', '</thinking>'] }));

vi.mock('../src/state.js', () => ({
    getSettings: () => getSettingsMock(),
}));

function setStripPatterns(patterns) {
    getSettingsMock.mockReturnValue({ stripPatterns: patterns });
}

import { cleanSummarizerOutput } from '../src/prompts.js';

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

describe('prompt toggle management', () => {
    const makeManager = () => ({
        collection: [
            { identifier: 'a', name: 'A' },
            { identifier: 'b', name: 'B' },
            { identifier: 'c', name: 'C' },
        ],
        order: [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'c', enabled: true },
        ],
    });

    it('captures the enabled state of each prompt in a snapshot', async () => {
        const ctx = {
            promptManager: {
                getPromptCollection: () => makeManager(),
                getPromptOrderEntries: () => makeManager().order,
            },
        };
        globalThis.SillyTavern = { getContext: () => ctx };
        const { snapshotPromptToggles } = await import('../src/prompts.js');
        const snap = snapshotPromptToggles();
        expect(snap.get('a')).toBe(true);
        expect(snap.get('b')).toBe(false);
        expect(snap.get('c')).toBe(true);
    });

    it('disables all prompts managed by promptManager', async () => {
        const mgr = makeManager();
        const ctx = {
            promptManager: {
                getPromptCollection: () => mgr,
                getPromptOrderEntries: () => mgr.order,
            },
        };
        globalThis.SillyTavern = { getContext: () => ctx };
        const { disableAllPromptToggles } = await import('../src/prompts.js');
        disableAllPromptToggles();
        expect(mgr.order.filter((e) => e.enabled)).toHaveLength(0);
    });

    it('restores previously snapshot toggles', async () => {
        const mgr = makeManager();
        const ctx = {
            promptManager: {
                getPromptCollection: () => mgr,
                getPromptOrderEntries: () => mgr.order,
            },
        };
        globalThis.SillyTavern = { getContext: () => ctx };
        mgr.order.forEach((e) => {
            e.enabled = false;
        });
        // Capture the original snapshot via a fresh manager with original enabled flags.
        const origMgr = makeManager();
        globalThis.SillyTavern = {
            getContext: () => ({
                promptManager: {
                    getPromptCollection: () => origMgr,
                    getPromptOrderEntries: () => origMgr.order,
                },
            }),
        };
        const { snapshotPromptToggles } = await import('../src/prompts.js');
        const snap = snapshotPromptToggles();
        // Now switch back to the disabled manager and restore.
        globalThis.SillyTavern = { getContext: () => ctx };
        const { restorePromptToggles } = await import('../src/prompts.js');
        restorePromptToggles(snap);
        expect(mgr.order.find((e) => e.identifier === 'a').enabled).toBe(true);
        expect(mgr.order.find((e) => e.identifier === 'b').enabled).toBe(false);
        expect(mgr.order.find((e) => e.identifier === 'c').enabled).toBe(true);
    });
});
