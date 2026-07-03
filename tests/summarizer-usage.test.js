import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));

vi.mock('../src/core/connectionutil.js', () => ({
    sendSummarizerRequest: mocks.sendSummarizerRequest,
}));

let consoleLogSpy;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.toastr = {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
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
                rawChars: 30,
                finalChars: 20,
                savedChars: 10,
                savedPercent: 33.333,
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
        expect(usageLog?.[1]).toContain('regex chars 30->20');
        expect(usageLog?.[1]).toContain('tokens prompt=12 completion=4 total=16');
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
