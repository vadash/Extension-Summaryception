import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state.js so chatutils does not need a live SillyTavern global.
vi.mock('../src/foundation/state.js', () => ({
    getChatStore: vi.fn(() => ({ layers: [] })),
    getSettings: vi.fn(() => ({ applyRegexScripts: false })),
}));

vi.mock('../src/core/regex-proxy.js', () => ({
    applyRegexToMessage: vi.fn(async (text) => text),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: false });
    vi.mocked(applyRegexToMessage).mockImplementation(async (text) => text);
});

import { getSettings } from '../src/foundation/state.js';
import { applyRegexToMessage } from '../src/core/regex-proxy.js';
import {
    getAssistantTurns,
    getVisibleAssistantTurns,
    buildPassageFromRange,
    buildPassageFromRangeWithStats,
    buildFullContext,
} from '../src/core/chatutils.js';

function msg({
    isUser = false,
    isSystem = false,
    isHidden = false,
    mes = 'text',
    name = 'Assistant',
    ghosted = false,
} = {}) {
    return {
        is_user: isUser,
        is_system: isSystem,
        is_hidden: isHidden,
        mes,
        name,
        extra: ghosted ? { sc_ghosted: true } : {},
    };
}

describe('getAssistantTurns', () => {
    it('returns only assistant messages, preserving their chat index', () => {
        const chat = [
            msg({ isUser: true, mes: 'Hi' }),
            msg({ mes: 'Hello!' }),
            msg({ mes: 'Anything else?' }),
        ];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(2);
        expect(turns.map((t) => t.index)).toEqual([1, 2]);
    });

    it('considers system messages that were ghosted as assistant turns', () => {
        const chat = [
            msg({ isSystem: true, mes: 'sys', ghosted: true }),
            msg({ isSystem: true, mes: 'plain sys' }),
        ];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(0);
    });

    it('skips messages whose mes is empty or whitespace', () => {
        const chat = [msg({ mes: '' }), msg({ mes: '   ' }), msg({ mes: 'real' })];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(2);
    });
});

describe('getVisibleAssistantTurns', () => {
    it('excludes user, system, and ghosted messages', () => {
        const chat = [
            msg({ isUser: true }),
            msg({ ghosted: true }),
            msg({ isSystem: true }),
            msg({ mes: 'visible' }),
        ];
        const turns = getVisibleAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(3);
    });
});

describe('buildPassageFromRange', () => {
    it('prefixes each speaker and joins with newlines', async () => {
        const chat = [msg({ isUser: true, mes: 'go north' }), msg({ mes: 'You enter a forest.' })];
        const passage = await buildPassageFromRange(chat, 0, 1);
        expect(passage).toBe(['Player: go north', 'Assistant: You enter a forest.'].join('\n'));
    });

    it('skips messages hidden by the user but keeps our ghosted ones', async () => {
        const chat = [msg({ isHidden: true, mes: 'secret' }), msg({ ghosted: true, mes: 'ours' })];
        await expect(buildPassageFromRange(chat, 0, 1)).resolves.toBe('Assistant: ours');
    });

    it('handles a missing or empty message inside the range', async () => {
        const chat = [msg({ mes: 'good' }), msg({ mes: '' })];
        await expect(buildPassageFromRange(chat, 0, 1)).resolves.toBe('Assistant: good');
    });
});

describe('buildPassageFromRangeWithStats', () => {
    it('reports matching raw and final chars when regex is off', async () => {
        const chat = [msg({ isUser: true, mes: 'go north' }), msg({ mes: 'You enter.' })];
        const result = await buildPassageFromRangeWithStats(chat, 0, 1);

        expect(result.text).toBe(['Player: go north', 'Assistant: You enter.'].join('\n'));
        expect(result.stats).toEqual({
            rawChars: result.text.length,
            finalChars: result.text.length,
            savedChars: 0,
            savedPercent: 0,
            changedMessageCount: 0,
        });
        expect(applyRegexToMessage).not.toHaveBeenCalled();
    });

    it('reports saved chars when regex shrinks rendered text', async () => {
        vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: true });
        vi.mocked(applyRegexToMessage).mockResolvedValue('visible');

        const chat = [msg({ mes: 'visible hidden' })];
        const result = await buildPassageFromRangeWithStats(chat, 0, 0);

        expect(result.text).toBe('Assistant: visible');
        expect(result.stats.rawChars).toBe('Assistant: visible hidden'.length);
        expect(result.stats.finalChars).toBe('Assistant: visible'.length);
        expect(result.stats.savedChars).toBe(' hidden'.length);
        expect(result.stats.savedPercent).toBeCloseTo(
            (' hidden'.length / 'Assistant: visible hidden'.length) * 100,
        );
        expect(result.stats.changedMessageCount).toBe(1);
    });

    it('reports negative saved chars when regex expands rendered text', async () => {
        vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: true });
        vi.mocked(applyRegexToMessage).mockResolvedValue('short expanded');
        const expandedChars = ' expanded'.length;

        const chat = [msg({ mes: 'short' })];
        const result = await buildPassageFromRangeWithStats(chat, 0, 0);

        expect(result.text).toBe('Assistant: short expanded');
        expect(result.stats.rawChars).toBe('Assistant: short'.length);
        expect(result.stats.finalChars).toBe('Assistant: short expanded'.length);
        expect(result.stats.savedChars).toBe(-expandedChars);
        expect(result.stats.savedPercent).toBeCloseTo(
            (-expandedChars / 'Assistant: short'.length) * 100,
        );
        expect(result.stats.changedMessageCount).toBe(1);
    });
});

describe('buildFullContext', () => {
    it('returns the documented placeholder when no layers exist', () => {
        expect(buildFullContext(0)).toBe('(none yet)');
    });

    it('builds context from layers when the store has content', async () => {
        vi.resetModules();
        vi.doMock('../src/foundation/state.js', () => ({
            getSettings: () => ({ applyRegexScripts: false }),
            getChatStore: () => ({
                layers: [[{ text: 'tip 1' }, { text: 'tip 2' }], [{ text: 'meta 1' }]],
            }),
        }));
        const mod = await import('../src/core/chatutils.js');
        expect(mod.buildFullContext(0)).toContain('tip 1');
        expect(mod.buildFullContext(0)).toContain('meta 1');
        expect(mod.buildFullContext(1)).toBe('meta 1');
        vi.doUnmock('../src/foundation/state.js');
    });
});
