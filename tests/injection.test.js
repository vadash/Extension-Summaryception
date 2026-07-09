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

function advancedSettings(settings = {}) {
    return { uiMode: 'advanced', enabled: true, ...settings };
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
            settings: advancedSettings({
                injectionTemplate: 'BEGIN\n{{summary}}\nEND',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toBe(
            [
                'BEGIN',
                '[CURRENT STATE]',
                'location: dock',
                '',
                '[CHRONOLOGY]',
                'layer two [Historical note: location is tower; hooks is open gate]',
                'layer zero A',
                'layer zero B',
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
            settings: advancedSettings({
                injectionTemplate: 'custom prefix\n{{summary}}\ncustom suffix',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toBe(
            ['custom prefix', '[CHRONOLOGY]', 'recent summary', 'custom suffix'].join('\n'),
        );
    });

    it('renders chronology anchors from snippet metadata without backfilling unanchored snippets', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nanchored recent\n\n[STATE]',
                                sourceRange: [100, 120],
                                currentDateTime: '2024-12-03 10 Wed',
                            },
                            {
                                text: '[NARRATIVE]\nunanchored recent\n\n[STATE]',
                            },
                        ],
                    ],
                }),
            },
            settings: advancedSettings({
                injectionTemplate: '{{summary}}',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');

        expect(assembleSummaryBlock()).toContain(
            '[msgs 100-120; current 2024-12-03 10 Wed] anchored recent\nunanchored recent',
        );
        expect(assembleSummaryBlock()).not.toContain('[msgs unknown');
        expect(assembleSummaryBlock()).not.toContain('2024-12-03 06 Wed ->');
    });

    it('strips a stored leading anchor when metadata provides the rendered anchor', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text:
                                    '[NARRATIVE]\n' +
                                    '[msgs 0-139; 2024-07-04 14 Thu -> unknown] anchored event\n\n' +
                                    '[STATE]',
                                sourceRange: [0, 139],
                                currentDateTime: '2024-07-05 12 Fri',
                            },
                        ],
                    ],
                }),
            },
            settings: advancedSettings({
                injectionTemplate: '{{summary}}',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');
        const assembled = assembleSummaryBlock();

        expect(assembled).toContain('[msgs 0-139; current 2024-07-05 12 Fri] anchored event');
        expect(assembled).not.toContain('-> unknown] [msgs');
        expect(assembled).not.toContain('-> unknown] anchored event');
    });

    it('renders current time metadata without start/end ranges', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: '[NARRATIVE]\nlatest event\n\n[STATE]\ncurrent_date_time: 2024-07-10 19 Wed',
                                sourceRange: [283, 298],
                                currentDateTime: '2024-07-10 19 Wed',
                            },
                        ],
                    ],
                }),
            },
            settings: advancedSettings({
                injectionTemplate: '{{summary}}',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');
        const assembled = assembleSummaryBlock();

        expect(assembled).toContain('[msgs 283-298; current 2024-07-10 19 Wed] latest event');
        expect(assembled).not.toContain('2024-07-04 14 Thu -> unknown');
    });

    it('strips repeated leading anchors when rendering', async () => {
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text:
                                    '[NARRATIVE]\n' +
                                    '[msgs 0-139; 2024-07-04 14 Thu -> unknown] ' +
                                    '[msgs 0-139; current 2024-07-05 12 Fri] anchored event\n\n' +
                                    '[STATE]',
                                sourceRange: [0, 139],
                                currentDateTime: '2024-07-05 12 Fri',
                            },
                        ],
                    ],
                }),
            },
            settings: advancedSettings({
                injectionTemplate: '{{summary}}',
            }),
        });

        const { assembleSummaryBlock } = await import('../src/features/injection.js');
        const assembled = assembleSummaryBlock();

        expect(assembled).toContain('[msgs 0-139; current 2024-07-05 12 Fri] anchored event');
        expect(assembled).not.toContain('] [msgs');
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
            settings: advancedSettings({
                injectionTemplate: 'BEGIN\n{{summary}}\nEND',
            }),
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
            settings: advancedSettings({
                debugMode: true,
            }),
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

    it('maps independent in-chat role and depth settings', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'cache',
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

    it('ignores depth outside in-chat placement', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'standard',
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

    it('maps macro-only placement to a cleared direct extension prompt', async () => {
        const { getMemoryInjectionOptions } = await import('../src/features/injection.js');

        expect(
            getMemoryInjectionOptions({
                memoryMode: 'cache',
                customMemoryPosition: 'macro_only',
                customMemoryRole: 'assistant',
                customMemoryDepth: 42,
            }),
        ).toEqual({
            position: -1,
            depth: 0,
            scan: false,
            role: 0,
        });
    });
});

describe('memory macro', () => {
    it('registers the Summaryception macro through the ST facade fallback', async () => {
        const registerMacro = vi.fn();
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'macro summary' }]],
                }),
            },
            settings: advancedSettings({
                injectionTemplate: 'BEGIN\n{{summary}}\nEND',
            }),
            registerMacro,
        });

        const { MEMORY_MACRO_NAME, registerSummaryceptionMemoryMacro } =
            await import('../src/features/injection.js');

        await expect(registerSummaryceptionMemoryMacro()).resolves.toBe(true);
        expect(registerMacro).toHaveBeenCalledWith(
            MEMORY_MACRO_NAME,
            expect.any(Function),
            'Returns the current Summaryception memory block.',
        );

        const handler = registerMacro.mock.calls[0][1];
        expect(handler()).toBe(['BEGIN', '[CHRONOLOGY]', 'macro summary', 'END'].join('\n'));
    });

    it('clears direct injection when placement is macro only', async () => {
        const setExtensionPrompt = vi.fn();
        installSillyTavernStub({
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ text: 'macro-only summary' }]],
                }),
            },
            settings: advancedSettings({
                customMemoryPosition: 'macro_only',
                injectionTemplate: '{{summary}}',
            }),
            setExtensionPrompt,
        });

        const { updateInjection } = await import('../src/features/injection.js');
        updateInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith('summaryception', '', -1, 0, false, 0);
    });
});
