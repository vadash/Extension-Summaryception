import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSillyTavernStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));

vi.mock('../src/core/connectionutil.js', () => ({
    ConnectionError: class ConnectionError extends Error {
        constructor(message, { retryable = false, status = null } = {}) {
            super(message);
            this.name = 'ConnectionError';
            this.retryable = retryable;
            this.status = status;
        }
    },
    resolveFallbackSummarizerConnectionSettings: () => null,
    resolveSummarizerConnectionSettings: (settings) => settings,
    sendSummarizerRequest: mocks.sendSummarizerRequest,
}));

let consoleLogSpy;
let consoleGroupCollapsedSpy;
let consoleGroupEndSpy;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleGroupCollapsedSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    consoleGroupEndSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
});

afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleGroupCollapsedSpy.mockRestore();
    consoleGroupEndSpy.mockRestore();
});

function findConsoleLogContaining(text) {
    return consoleLogSpy.mock.calls.find((call) =>
        call.some((part) => String(part).includes(text)),
    );
}

function getConsoleText() {
    return consoleLogSpy.mock.calls.flat().map(String).join('\n');
}

function findGroupTitleContaining(text) {
    return consoleGroupCollapsedSpy.mock.calls.find(([title]) => String(title).includes(text))?.[0];
}

function installDebugContext() {
    const ctx = installSillyTavernStub({
        settings: {
            debugMode: true,
            summarizerSystemPrompt: 'SYS',
            summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
            stripPatterns: [],
        },
    });
    ctx.getTokenCountAsync = vi.fn();
    return ctx;
}

describe('summarizer usage logging', () => {
    it('logs a full Layer 0 prompt and response transaction when prompt logging is enabled', async () => {
        installSillyTavernStub({
            settings: {
                promptLogMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue('summary text');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [1, 3],
            assistantTurnCount: 2,
        });

        expect(findGroupTitleContaining('[Summaryception] [LLM] layer0 turns 1-3')).toContain(
            'SUCCESS',
        );
        expect(findGroupTitleContaining('System Prompt')).toBe('System Prompt');
        expect(findGroupTitleContaining('User Prompt')).toBe('User Prompt');
        expect(findGroupTitleContaining('Raw LLM Response')).toBe('Raw LLM Response');
        expect(findGroupTitleContaining('Cleaned Summary')).toBe('Cleaned Summary');

        const loggedText = getConsoleText();
        expect(loggedText).toContain('SYS');
        expect(loggedText).toContain('CTX prior context STORY source passage');
        expect(loggedText).toContain('summary text');
    });

    it('labels promotion prompt logs with source and destination layers', async () => {
        installSillyTavernStub({
            settings: {
                promptLogMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue('summary text');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 1,
            mergedSnippetCount: 2,
        });

        expect(findGroupTitleContaining('promotion L1->L2 (2 snippets)')).toContain('SUCCESS');
        const loggedText = getConsoleText();
        expect(loggedText).toContain('PROMO_SYS');
        expect(loggedText).toContain('PROMO deep context STORY merged snippets');
        expect(loggedText).toContain('summary text');
    });

    it('logs failed prompt and response attempts with error details', async () => {
        installSillyTavernStub({
            settings: {
                promptLogMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        const { RETRY_CONFIG } = await import('../src/foundation/constants.js');
        const originalMaxRetries = RETRY_CONFIG.maxRetries;
        RETRY_CONFIG.maxRetries = 0;
        mocks.sendSummarizerRequest.mockResolvedValueOnce('<thinking>only thoughts</thinking>');

        try {
            const { callSummarizer } = await import('../src/core/summarizer-request.js');
            await callSummarizer('source passage', 'prior context', {
                kind: 'layer0',
                sourceRange: [4, 5],
                assistantTurnCount: 1,
            });
        } finally {
            RETRY_CONFIG.maxRetries = originalMaxRetries;
        }

        expect(findGroupTitleContaining('layer0 turns 4-5')).toContain('EMPTY');
        expect(findGroupTitleContaining('Error')).toBe('Error');
        expect(getConsoleText()).toContain('<thinking>only thoughts</thinking>');
        expect(getConsoleText()).toContain('Empty response from summarizer');
    });

    it('logs estimated prompt, completion, and total tokens after a successful call', async () => {
        const ctx = installDebugContext();
        ctx.getTokenCountAsync.mockResolvedValueOnce(12).mockResolvedValueOnce(4);
        mocks.sendSummarizerRequest.mockResolvedValue(' clean summary ');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        const summary = await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [0, 2],
            assistantTurnCount: 2,
            regexStats: {
                rawTokens: 30,
                finalTokens: 20,
                savedTokens: 10,
                savedPercent: 33.333,
                rawTokensEstimated: false,
                finalTokensEstimated: false,
                savedTokensEstimated: false,
                changedMessageCount: 1,
            },
        });

        expect(summary).toBe('clean summary');
        expect(ctx.getTokenCountAsync).toHaveBeenCalledTimes(2);
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('SYS');
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('prior context');
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('source passage');
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).toBe('clean summary');

        const usageLog = findConsoleLogContaining('LLM call layer0 turns 0-2');
        expect(usageLog?.join(' ')).toContain('regex tokens 30->20');
        expect(usageLog?.join(' ')).toContain('tokens prompt=12 completion=4 total=16');
    });

    it('uses promotion prompts for promotion usage token estimates', async () => {
        const ctx = installSillyTavernStub({
            settings: {
                debugMode: true,
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'L0 {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        ctx.getTokenCountAsync = vi
            .fn()
            .mockResolvedValueOnce(6)
            .mockResolvedValueOnce(14)
            .mockResolvedValueOnce(5);
        mocks.sendSummarizerRequest.mockResolvedValue('merged summary');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 1,
            mergedSnippetCount: 2,
        });

        expect(ctx.getTokenCountAsync).toHaveBeenCalledTimes(3);
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toBe('merged snippets');
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).toContain('PROMO_SYS');
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).toContain(
            'PROMO deep context MEMORY merged snippets',
        );
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).not.toContain('L0_SYS');

        const usageLog = findConsoleLogContaining('LLM call promotion L1');
        expect(usageLog?.join(' ')).toContain('memory=6->5');
        expect(usageLog?.join(' ')).toContain('tokens prompt=14 completion=5 total=19');
    });

    it('formats large logged token counts with a compact k suffix', async () => {
        installDebugContext();

        const { recordSummarizerUsage } = await import('../src/core/summarizer-usage.js');
        recordSummarizerUsage({
            metadata: {
                kind: 'layer0',
                sourceRange: [0, 1],
                assistantTurnCount: 1,
            },
            promptTokens: 8377,
            completionTokens: 1234567,
            totalTokens: 1242944,
        });

        const usageLog = findConsoleLogContaining('LLM call layer0 turns 0-1');
        expect(usageLog?.join(' ')).toContain('tokens prompt=8k completion=1234k total=1242k');
    });

    it('marks fallback token estimates when the tokenizer is unavailable', async () => {
        installSillyTavernStub({
            settings: {
                debugMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue('fallback summary');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        const summary = await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [0, 2],
            assistantTurnCount: 2,
        });

        expect(summary).toBe('fallback summary');

        const usageLog = findConsoleLogContaining('LLM call layer0 turns 0-2');
        expect(usageLog?.join(' ')).toContain('tokens prompt=~');
        expect(usageLog?.join(' ')).toContain('completion=~');
        expect(usageLog?.join(' ')).toContain('total=~');
        expect(usageLog?.join(' ')).not.toContain('chars');
    });

    it('logs the max-token call once when a usage run ends', async () => {
        installDebugContext();

        const { recordSummarizerUsage, withUsageRun } =
            await import('../src/core/summarizer-usage.js');

        await withUsageRun('auto worker drain', async () => {
            recordSummarizerUsage({
                metadata: {
                    kind: 'layer0',
                    sourceRange: [0, 1],
                    assistantTurnCount: 1,
                },
                promptTokens: 10,
                completionTokens: 2,
                totalTokens: 12,
            });
            recordSummarizerUsage({
                metadata: {
                    kind: 'promotion',
                    layerIndex: 0,
                    mergedSnippetCount: 3,
                },
                promptTokens: 20,
                completionTokens: 5,
                totalTokens: 25,
            });
        });

        const maxLogs = consoleLogSpy.mock.calls.filter((call) =>
            call.some((part) => String(part).includes('LLM run auto worker drain max call')),
        );
        expect(maxLogs).toHaveLength(1);
        expect(maxLogs[0].join(' ')).toContain('#2 promotion L0');
        expect(maxLogs[0].join(' ')).toContain('total=25 tokens');
    });

    it('skips the max-token line when a usage run makes no LLM calls', async () => {
        installDebugContext();

        const { withUsageRun } = await import('../src/core/summarizer-usage.js');
        await withUsageRun('manual batch', async () => {});

        expect(
            consoleLogSpy.mock.calls.some((call) =>
                call.some((part) => String(part).includes('LLM run manual batch max call')),
            ),
        ).toBe(false);
    });
});
