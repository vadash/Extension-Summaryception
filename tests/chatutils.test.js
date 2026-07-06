import { describe, it, expect, vi, beforeEach } from 'vitest';
import { countTokens, makeMessage } from './test-helpers.js';

// Mock state.js so chatutils does not need a live SillyTavern global.
vi.mock('../src/foundation/state.js', () => ({
    getChatStore: vi.fn(() => ({ layers: [] })),
    getSettings: vi.fn(() => ({ applyRegexScripts: false })),
}));

vi.mock('../src/core/regex-proxy.js', () => ({
    applyRegexToMessage: vi.fn(async (text) => text),
}));

let getTokenCountAsync;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: false });
    vi.mocked(applyRegexToMessage).mockImplementation(async (text) => text);
    getTokenCountAsync = vi.fn(async (text) => countTokens(text));
    globalThis.SillyTavern = {
        getContext: () => ({
            getTokenCountAsync,
        }),
    };
});

import { getSettings } from '../src/foundation/state.js';
import { applyRegexToMessage } from '../src/core/regex-proxy.js';
import {
    findLastMessage,
    getAssistantTurns,
    getVisibleAssistantTurns,
    iterateChatRange,
    buildPassageFromRange,
    buildPassageFromRangeWithStats,
    buildFullContext,
    buildMemoryInjection,
} from '../src/core/chatutils.js';

describe('iterateChatRange', () => {
    it('walks a clamped forward range', () => {
        const chat = Array.from({ length: 4 }, (_value, index) => makeMessage({ mes: `${index}` }));

        expect([...iterateChatRange(chat, -3, 2)].map((entry) => entry.index)).toEqual([0, 1, 2]);
    });

    it('walks a clamped backward range', () => {
        const chat = Array.from({ length: 4 }, (_value, index) => makeMessage({ mes: `${index}` }));

        expect([...iterateChatRange(chat, 99, 1)].map((entry) => entry.index)).toEqual([3, 2, 1]);
    });

    it('returns no entries for empty or non-overlapping ranges', () => {
        const chat = [makeMessage({ mes: 'only' })];

        expect([...iterateChatRange([], 0, 1)]).toEqual([]);
        expect([...iterateChatRange(chat, -5, -1)]).toEqual([]);
        expect([...iterateChatRange(chat, 5, 6)]).toEqual([]);
    });
});

describe('findLastMessage', () => {
    it('finds the latest matching message at or before the start index', () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'u0' }),
            makeMessage({ mes: 'a1' }),
            makeMessage({ isUser: true, mes: 'u2' }),
        ];

        const result = findLastMessage(chat, chat.length - 1, (message) => !message.is_user);

        expect(result).toMatchObject({ index: 1, message: chat[1] });
    });

    it('honors the lower search bound', () => {
        const chat = [
            makeMessage({ mes: 'a0' }),
            makeMessage({ isUser: true, mes: 'u1' }),
            makeMessage({ mes: 'a2' }),
        ];

        expect(findLastMessage(chat, 1, (message) => !message.is_user, 1)).toBeNull();
        expect(findLastMessage(chat, -1, () => true)).toBeNull();
    });
});

describe('getAssistantTurns', () => {
    it('returns only assistant messages, preserving their chat index', () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'Hi' }),
            makeMessage({ mes: 'Hello!' }),
            makeMessage({ mes: 'Anything else?' }),
        ];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(2);
        expect(turns.map((t) => t.index)).toEqual([1, 2]);
    });

    it('considers system messages that were ghosted as assistant turns', () => {
        const chat = [
            makeMessage({ isSystem: true, mes: 'sys', ghosted: true }),
            makeMessage({ isSystem: true, mes: 'plain sys' }),
        ];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(0);
    });

    it('skips messages whose mes is empty or whitespace', () => {
        const chat = [
            makeMessage({ mes: '' }),
            makeMessage({ mes: '   ' }),
            makeMessage({ mes: 'real' }),
        ];
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(2);
    });
});

describe('getVisibleAssistantTurns', () => {
    it('excludes user, system, and ghosted messages', () => {
        const chat = [
            makeMessage({ isUser: true }),
            makeMessage({ ghosted: true }),
            makeMessage({ isSystem: true }),
            makeMessage({ mes: 'visible' }),
        ];
        const turns = getVisibleAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].index).toBe(3);
    });
});

describe('buildPassageFromRange', () => {
    it('prefixes each speaker and joins with newlines', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'go north' }),
            makeMessage({ mes: 'You enter a forest.' }),
        ];
        const passage = await buildPassageFromRange(chat, 0, 1);
        expect(passage).toBe(['Player: go north', 'Assistant: You enter a forest.'].join('\n'));
    });

    it('skips messages hidden by the user but keeps our ghosted ones', async () => {
        const chat = [
            makeMessage({ isHidden: true, mes: 'secret' }),
            makeMessage({ ghosted: true, mes: 'ours' }),
        ];
        await expect(buildPassageFromRange(chat, 0, 1)).resolves.toBe('Assistant: ours');
    });

    it('handles a missing or empty message inside the range', async () => {
        const chat = [makeMessage({ mes: 'good' }), makeMessage({ mes: '' })];
        await expect(buildPassageFromRange(chat, 0, 1)).resolves.toBe('Assistant: good');
    });
});

describe('buildPassageFromRangeWithStats', () => {
    it('reports matching raw and final tokens when regex is off', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'go north' }),
            makeMessage({ mes: 'You enter.' }),
        ];
        const result = await buildPassageFromRangeWithStats(chat, 0, 1);

        expect(result.text).toBe(['Player: go north', 'Assistant: You enter.'].join('\n'));
        expect(result.stats).toEqual({
            rawTokens: countTokens(result.text),
            finalTokens: countTokens(result.text),
            savedTokens: 0,
            savedPercent: 0,
            rawTokensEstimated: false,
            finalTokensEstimated: false,
            savedTokensEstimated: false,
            changedMessageCount: 0,
        });
        expect(applyRegexToMessage).not.toHaveBeenCalled();
    });

    it('caches per-message token counts and refreshes them after edits', async () => {
        const chat = [makeMessage({ mes: 'first count' })];

        const first = await buildPassageFromRangeWithStats(chat, 0, 0);

        expect(chat[0].extra.sc_token_count).toEqual({
            textLength: 'Assistant: first count'.length * 2,
            rawTokens: countTokens('Assistant: first count'),
            finalTokens: countTokens('Assistant: first count'),
            rawTokensEstimated: false,
            finalTokensEstimated: false,
        });
        expect(getTokenCountAsync).toHaveBeenCalledTimes(1);

        getTokenCountAsync.mockClear();
        chat[0].mes = 'edited source with many more words';
        const second = await buildPassageFromRangeWithStats(chat, 0, 0);

        expect(second.text).toBe('Assistant: edited source with many more words');
        expect(second.stats.rawTokens).toBe(countTokens(second.text));
        expect(second.stats.finalTokens).toBe(countTokens(second.text));
        expect(second.stats.rawTokens).toBeGreaterThan(first.stats.rawTokens);
        expect(second.stats.finalTokens).toBeGreaterThan(first.stats.finalTokens);
        expect(getTokenCountAsync).toHaveBeenCalledTimes(1);
        expect(chat[0].extra.sc_token_count).toEqual({
            textLength: second.text.length * 2,
            rawTokens: countTokens(second.text),
            finalTokens: countTokens(second.text),
            rawTokensEstimated: false,
            finalTokensEstimated: false,
        });
    });

    it('reports saved tokens when regex shrinks rendered text', async () => {
        vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: true });
        vi.mocked(applyRegexToMessage).mockResolvedValue('visible');

        const chat = [makeMessage({ mes: 'visible hidden' })];
        const result = await buildPassageFromRangeWithStats(chat, 0, 0);
        const rawTokens = countTokens('Assistant: visible hidden');
        const finalTokens = countTokens('Assistant: visible');
        const savedTokens = rawTokens - finalTokens;

        expect(result.text).toBe('Assistant: visible');
        expect(result.stats.rawTokens).toBe(rawTokens);
        expect(result.stats.finalTokens).toBe(finalTokens);
        expect(result.stats.savedTokens).toBe(savedTokens);
        expect(result.stats.savedPercent).toBeCloseTo((savedTokens / rawTokens) * 100);
        expect(result.stats.rawTokensEstimated).toBe(false);
        expect(result.stats.finalTokensEstimated).toBe(false);
        expect(result.stats.savedTokensEstimated).toBe(false);
        expect(result.stats.changedMessageCount).toBe(1);
    });

    it('reports negative saved tokens when regex expands rendered text', async () => {
        vi.mocked(getSettings).mockReturnValue({ applyRegexScripts: true });
        vi.mocked(applyRegexToMessage).mockResolvedValue('short expanded');

        const chat = [makeMessage({ mes: 'short' })];
        const result = await buildPassageFromRangeWithStats(chat, 0, 0);
        const rawTokens = countTokens('Assistant: short');
        const finalTokens = countTokens('Assistant: short expanded');
        const savedTokens = rawTokens - finalTokens;

        expect(result.text).toBe('Assistant: short expanded');
        expect(result.stats.rawTokens).toBe(rawTokens);
        expect(result.stats.finalTokens).toBe(finalTokens);
        expect(result.stats.savedTokens).toBe(savedTokens);
        expect(result.stats.savedPercent).toBeCloseTo((savedTokens / rawTokens) * 100);
        expect(result.stats.rawTokensEstimated).toBe(false);
        expect(result.stats.finalTokensEstimated).toBe(false);
        expect(result.stats.savedTokensEstimated).toBe(false);
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
        expect(mod.buildFullContext(1)).toBe('[CHRONOLOGY]\nmeta 1');
        vi.doUnmock('../src/foundation/state.js');
    });
});

describe('buildMemoryInjection', () => {
    it('compiles current state and narrative chronology deepest first', () => {
        const memory = buildMemoryInjection([
            [
                {
                    text: '[NARRATIVE]\nRecent scene.\n\n[STATE]\nlocation: bridge\nhooks: escape',
                },
            ],
            [
                {
                    text: '[NARRATIVE]\nOlder scene.\n\n[STATE]\nplace: tower\ninventory: key',
                },
            ],
        ]);

        expect(memory).toBe(
            [
                '[CURRENT STATE]',
                'location: bridge',
                'inventory: key',
                'hooks: escape',
                '',
                '[CHRONOLOGY]',
                'Older scene. Recent scene.',
            ].join('\n'),
        );
    });
});
