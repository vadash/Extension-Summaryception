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

const VALID_L0_SUMMARY = [
    '[NARRATIVE]',
    'The source passage was summarized into a concise memory.',
    '',
    '[STATE]',
    'current_date_time: 2024-12-03 06 Wed',
    'timeline_start: 2024-12-03 06 Wed',
    'timeline_end: 2024-12-03 06 Wed',
].join('\n');

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

function findJsonLog(type) {
    for (const call of consoleLogSpy.mock.calls) {
        for (const part of call) {
            if (typeof part !== 'string') {
                continue;
            }
            try {
                const parsed = JSON.parse(part);
                if (parsed?.type === type) {
                    return parsed;
                }
            } catch {
                // Not a JSON payload log.
            }
        }
    }
    return null;
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
    it('logs full Layer 0 input without output when input logging is enabled', async () => {
        installSillyTavernStub({
            settings: {
                promptInputLogMode: true,
                promptOutputLogMode: false,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue(VALID_L0_SUMMARY);

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [1, 3],
            assistantTurnCount: 2,
        });

        expect(findGroupTitleContaining('[Summaryception] [LLM] L0 turns 1-3')).toContain(
            'SUCCESS',
        );
        const inputLog = findJsonLog('summaryception.llm.input.v1');
        const outputLog = findJsonLog('summaryception.llm.output.v1');

        expect(inputLog).toMatchObject({
            label: 'L0 turns 1-3',
            route: 'primary',
            attempt: 1,
            messages: [
                { role: 'system', content: 'SYS' },
                {
                    role: 'user',
                    content: expect.stringContaining('CTX prior context STORY source passage'),
                },
            ],
        });
        expect(inputLog.messages[1].content).toContain('Target length: at most about 200 tokens');
        expect(inputLog.messages[1].content).toContain('current_date_time');
        expect(inputLog.messages[1].content).toContain('YYYY-MM-DD HH ddd');
        expect(outputLog).toBeNull();
        expect(getConsoleText()).not.toContain(VALID_L0_SUMMARY);
    });

    it('logs cleaned output without raw response or prompt content when output logging is enabled', async () => {
        installSillyTavernStub({
            settings: {
                promptInputLogMode: false,
                promptOutputLogMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue(
            `<thinking>private provider trace</thinking>${VALID_L0_SUMMARY}`,
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [1, 3],
            assistantTurnCount: 2,
        });

        const inputLog = findJsonLog('summaryception.llm.input.v1');
        const outputLog = findJsonLog('summaryception.llm.output.v1');

        expect(inputLog).toBeNull();
        expect(outputLog).toMatchObject({
            label: 'L0 turns 1-3',
            route: 'primary',
            attempt: 1,
            status: 'success',
            cleanedSummary: VALID_L0_SUMMARY,
            error: null,
        });
        expect(outputLog).not.toHaveProperty('rawResponse');
        expect(getConsoleText()).not.toContain('CTX prior context STORY source passage');
        expect(getConsoleText()).not.toContain('private provider trace');
        expect(getConsoleText()).not.toContain('Metadata');
    });

    it('logs both input and output for promotions when both toggles are enabled', async () => {
        installSillyTavernStub({
            settings: {
                promptInputLogMode: true,
                promptOutputLogMode: true,
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
        expect(findJsonLog('summaryception.llm.input.v1')).toMatchObject({
            label: 'promotion L1->L2 (2 snippets)',
            messages: [
                { role: 'system', content: 'PROMO_SYS' },
                {
                    role: 'user',
                    content: expect.stringContaining('PROMO deep context STORY merged snippets'),
                },
            ],
        });
        expect(findJsonLog('summaryception.llm.input.v1').messages[1].content).toContain(
            '<summaryception_promotion_constraints>',
        );
        expect(findJsonLog('summaryception.llm.output.v1')).toMatchObject({
            label: 'promotion L1->L2 (2 snippets)',
            cleanedSummary: 'summary text',
        });
        expect(findJsonLog('summaryception.llm.output.v1')).not.toHaveProperty('rawResponse');
    });

    it('logs failed prompt and response attempts with error details', async () => {
        installSillyTavernStub({
            settings: {
                promptOutputLogMode: true,
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

        expect(findGroupTitleContaining('L0 turns 4-5')).toContain('EMPTY');
        expect(findJsonLog('summaryception.llm.output.v1')).toMatchObject({
            status: 'empty',
            cleanedSummary: '',
            error: {
                name: 'Error',
                message: 'Empty response from summarizer',
            },
        });
        expect(findJsonLog('summaryception.llm.output.v1')).not.toHaveProperty('rawResponse');
        expect(getConsoleText()).not.toContain('only thoughts');
    });

    it('logs the final preprocessed input text passed to the provider', async () => {
        installSillyTavernStub({
            settings: {
                applyRegexScripts: true,
                promptInputLogMode: true,
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'STORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue(VALID_L0_SUMMARY);

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        await callSummarizer('Assistant: visible after regex', '', {
            kind: 'layer0',
            sourceRange: [0, 0],
            assistantTurnCount: 1,
        });

        const inputLog = findJsonLog('summaryception.llm.input.v1');
        expect(inputLog.messages[1].content).toContain('Assistant: visible after regex');
        expect(inputLog.messages[1].content).not.toContain('hidden before regex');
    });

    it('logs compact input, prompt, output, and regex savings after a successful call', async () => {
        const ctx = installDebugContext();
        ctx.getTokenCountAsync.mockResolvedValueOnce(32).mockResolvedValueOnce(4);
        mocks.sendSummarizerRequest.mockResolvedValue(` ${VALID_L0_SUMMARY} `);

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

        expect(summary).toBe(VALID_L0_SUMMARY);
        expect(ctx.getTokenCountAsync).toHaveBeenCalledTimes(2);
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('SYS');
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('prior context');
        expect(ctx.getTokenCountAsync.mock.calls[0][0]).toContain('source passage');
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).toBe(VALID_L0_SUMMARY);

        const usageLog = findConsoleLogContaining('LLM call CHAT -> L0 turns 0-2');
        expect(usageLog?.join(' ')).toContain('input 20, prompt 12, output 4');
        expect(usageLog?.join(' ')).toContain('regex saved 33%');
        expect(usageLog?.join(' ')).not.toContain('regex tokens');
        expect(usageLog?.join(' ')).not.toContain('total=');
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
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).toContain(
            '<summaryception_promotion_constraints>',
        );
        expect(ctx.getTokenCountAsync.mock.calls[1][0]).not.toContain('L0_SYS');

        const usageLog = findConsoleLogContaining('LLM call promotion L1 -> L2');
        expect(usageLog?.join(' ')).toContain('input 6, prompt 8, output 5');
        expect(usageLog?.join(' ')).toContain('saved 17%');
        expect(usageLog?.join(' ')).not.toContain('memory=6->5');
        expect(usageLog?.join(' ')).not.toContain('regex saved');
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

        const usageLog = findConsoleLogContaining('LLM call CHAT -> L0 turns 0-1');
        expect(usageLog?.join(' ')).toContain('input ?, prompt 8k, output 1234k');
        expect(usageLog?.join(' ')).not.toContain('total=');
    });

    it('logs promotion overflow reason and compression savings compactly', async () => {
        installDebugContext();

        const { recordSummarizerUsage } = await import('../src/core/summarizer-usage.js');
        recordSummarizerUsage({
            metadata: {
                kind: 'promotion',
                layerIndex: 0,
                mergedSnippetCount: 4,
                memoryTokensBefore: 944,
                overflowLayerIndex: 0,
                overflowMemoryCount: 31,
                overflowMemoryLimit: 30,
                overflowTokens: 13000,
                overflowTokenQuota: 12000,
            },
            promptTokens: 1359,
            completionTokens: 532,
            totalTokens: 1891,
        });

        const usageLog = findConsoleLogContaining('LLM call promotion L0 -> L1');
        const joinedLog = usageLog?.join(' ');
        expect(joinedLog).toContain('input 944, prompt 415, output 532');
        expect(joinedLog).toContain('overflow L0 31/30 memories, 13k/12k tokens');
        expect(joinedLog).toContain('saved 44%');
        expect(joinedLog).not.toContain('memory=944->532');
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
        mocks.sendSummarizerRequest.mockResolvedValue(VALID_L0_SUMMARY);

        const { callSummarizer } = await import('../src/core/summarizer-request.js');
        const summary = await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [0, 2],
            assistantTurnCount: 2,
        });

        expect(summary).toBe(VALID_L0_SUMMARY);

        const usageLog = findConsoleLogContaining('LLM call CHAT -> L0 turns 0-2');
        expect(usageLog?.join(' ')).toContain('input ?');
        expect(usageLog?.join(' ')).toContain('prompt ~');
        expect(usageLog?.join(' ')).toContain('output ~');
        expect(usageLog?.join(' ')).not.toContain('total=~');
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
        expect(maxLogs[0].join(' ')).toContain('#2 promotion L0 -> L1');
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
