import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSillyTavernStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));

vi.mock('../src/core/connectionutil.js', () => ({
    resolveSummarizerConnectionSettings: (settings) => settings,
    sendSummarizerRequest: mocks.sendSummarizerRequest,
}));

let consoleLogSpy;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    consoleLogSpy.mockRestore();
});

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
    it('logs a copyable full Layer 0 prompt block when prompt logging is enabled', async () => {
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

        const promptLog = consoleLogSpy.mock.calls.find(
            ([first]) =>
                typeof first === 'string' && first.includes('SUMMARYCEPTION LLM PROMPT START'),
        )?.[0];

        expect(promptLog).toContain('[Summaryception] LLM prompt: layer0 turns 1-3');
        expect(promptLog).toContain('[system]\nSYS');
        expect(promptLog).toContain('[user]\nCTX prior context STORY source passage');
        expect(promptLog).toContain('SUMMARYCEPTION LLM PROMPT END');
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

        const promptLog = consoleLogSpy.mock.calls.find(
            ([first]) =>
                typeof first === 'string' && first.includes('SUMMARYCEPTION LLM PROMPT START'),
        )?.[0];

        expect(promptLog).toContain('LLM prompt: promotion L1->L2 (2 snippets)');
        expect(promptLog).toContain('[system]\nPROMO_SYS');
        expect(promptLog).toContain('[user]\nPROMO deep context STORY merged snippets');
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

        const usageLog = consoleLogSpy.mock.calls.find((call) =>
            call[1]?.includes('LLM call layer0 turns 0-2'),
        );
        expect(usageLog?.[1]).toContain('regex tokens 30->20');
        expect(usageLog?.[1]).toContain('tokens prompt=12 completion=4 total=16');
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
        ctx.getTokenCountAsync = vi.fn().mockResolvedValueOnce(14).mockResolvedValueOnce(5);
        mocks.sendSummarizerRequest.mockResolvedValue('merged summary');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 1,
            mergedSnippetCount: 2,
        });

        expect(ctx.getTokenCountAsync).toHaveBeenCalledTimes(2);
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('PROMO_SYS');
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain(
            'PROMO deep context MEMORY merged snippets',
        );
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).not.toContain('L0_SYS');

        const usageLog = consoleLogSpy.mock.calls.find((call) =>
            call[1]?.includes('LLM call promotion L1'),
        );
        expect(usageLog?.[1]).toContain('tokens prompt=14 completion=5 total=19');
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

        const usageLog = consoleLogSpy.mock.calls.find((call) =>
            call[1]?.includes('LLM call layer0 turns 0-2'),
        );
        expect(usageLog?.[1]).toContain('tokens prompt=~');
        expect(usageLog?.[1]).toContain('completion=~');
        expect(usageLog?.[1]).toContain('total=~');
        expect(usageLog?.[1]).not.toContain('chars');
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
            call[1]?.includes('LLM run auto worker drain max call'),
        );
        expect(maxLogs).toHaveLength(1);
        expect(maxLogs[0][1]).toContain('#2 promotion L0');
        expect(maxLogs[0][1]).toContain('total=25 tokens');
    });

    it('skips the max-token line when a usage run makes no LLM calls', async () => {
        installDebugContext();

        const { withUsageRun } = await import('../src/core/summarizer-usage.js');
        await withUsageRun('manual batch', async () => {});

        expect(
            consoleLogSpy.mock.calls.some((call) =>
                call[1]?.includes('LLM run manual batch max call'),
            ),
        ).toBe(false);
    });
});
