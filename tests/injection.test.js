import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeSummaryStore } from './test-helpers.js';

let consoleLogSpy;

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    consoleLogSpy.mockRestore();
});

function countTokens(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

describe('assembleSummaryBlock', () => {
    it('returns an empty string when no layers contain snippets', async () => {
        installSillyTavernStub({
            metadata: { summaryception: makeSummaryStore() },
            settings: {},
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toBe('');
    });

    it('wraps clean memory deepest first and omits empty layers', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nlayer zero A\n\n[STATE]\nlocation: dock',
                            },
                            { text: 'layer zero B' },
                        ],
                        [],
                        [
                            {
                                text: '[NARRATIVE]\nlayer two\n\n[STATE]\nplace: tower\nhooks: open gate',
                            },
                        ],
                    ],
                }),
            },
            settings: {
                injectionTemplate: 'BEGIN\n{{summary}}\nEND',
            },
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toBe(
            [
                'BEGIN',
                '[CURRENT STATE]',
                'location: dock',
                '',
                '[CHRONOLOGY]',
                'layer two [Historical note: location is tower; hooks is open gate] layer zero A layer zero B',
                'END',
            ].join('\n'),
        );
    });

    it('preserves custom injection templates around the tagged layer block', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'recent summary' }]],
                }),
            },
            settings: {
                injectionTemplate: 'custom prefix\n{{summary}}\ncustom suffix',
            },
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toBe(
            ['custom prefix', '[CHRONOLOGY]', 'recent summary', 'custom suffix'].join('\n'),
        );
    });

    it('counts effective memory as the assembled injection with merged state', async () => {
        const layers = [
            [
                {
                    text: '[NARRATIVE]\nfirst\n\n[STATE]\nlocation: ' + 'dock '.repeat(12),
                },
                {
                    text: '[NARRATIVE]\nsecond\n\n[STATE]\nlocation: ' + 'tower '.repeat(12),
                },
                {
                    text:
                        '[NARRATIVE]\nthird\n\n[STATE]\nhooks: resolved\nlocation: ' +
                        'tower '.repeat(12),
                },
            ],
        ];
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({ layers }),
            },
            settings: {
                injectionTemplate: 'BEGIN\n{{summary}}\nEND',
            },
            getTokenCountAsync: async (text) => countTokens(text),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');
        const { getEffectiveMemoryUsage } = await import('../src/core/memory-budget.js');
        const { countTextTokens } = await import('../src/core/token-count.js');

        const assembled = assembleSummaryBlock();
        const usage = await getEffectiveMemoryUsage(layers, {
            injectionTemplate: 'BEGIN\n{{summary}}\nEND',
        });
        const assembledTokens = await countTextTokens(assembled);
        const rawSnippetTokens = countTokens(layers[0].map((snippet) => snippet.text).join(' '));

        expect(usage.total).toEqual(assembledTokens);
        expect(usage.total.count).toBeLessThan(rawSnippetTokens);
        expect(assembled).toContain('[CURRENT STATE]\nlocation: tower');
        expect(assembled).not.toContain('hooks: resolved');
    });
});

describe('injection diagnostics', () => {
    it('logs compact memory status when requested', async () => {
        const setExtensionPrompt = vi.fn();
        const ctx = installSillyTavernStub({
            metadata: {
                summaryception: {
                    layers: [[{ text: 'first summary' }]],
                    summarizedUpTo: 2,
                    ghostedIndices: [],
                },
            },
            settings: {
                debugMode: true,
            },
            setExtensionPrompt,
        });
        ctx.getTokenCountAsync = vi.fn(async (text) => countTokens(text));

        const { updateInjection } = await import('../src/features/injection.js');
        updateInjection({ logMemoryStatus: true });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const injectionLog = consoleLogSpy.mock.calls.find((call) =>
            call.some((part) => String(part).includes('Memory updated:')),
        );
        const joinedLog = injectionLog?.join(' ');
        expect(joinedLog).toMatch(/Memory updated: inject \d+ tokens; layers L0=1/);
        expect(joinedLog).not.toContain('chars');
    });
});

describe('memory injection options', () => {
    it('maps standard mode to in-prompt system memory at depth zero', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(getMemoryInjectionOptions({ memoryMode: 'standard' })).toEqual({
            position: 0,
            depth: 0,
            scan: false,
            role: 0,
        });
    });

    it('maps cache mode to the same stable in-prompt system placement', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(getMemoryInjectionOptions({ memoryMode: 'cache' })).toEqual({
            position: 0,
            depth: 0,
            scan: false,
            role: 0,
        });
    });

    it('maps custom in-chat role and depth settings', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'custom',
                customMemoryPosition: 'in_chat',
                customMemoryRole: 'user',
                customMemoryDepth: 42,
            }),
        ).toEqual({
            position: 1,
            depth: 42,
            scan: false,
            role: 1,
        });
    });

    it('ignores custom depth outside in-chat placement', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'custom',
                customMemoryPosition: 'before_prompt',
                customMemoryRole: 'assistant',
                customMemoryDepth: 42,
            }),
        ).toEqual({
            position: 2,
            depth: 0,
            scan: false,
            role: 2,
        });
    });
});
