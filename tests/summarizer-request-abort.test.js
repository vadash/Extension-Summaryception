import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSillyTavernStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
    resolveFallbackSummarizerConnectionSettings: vi.fn(),
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
    resolveFallbackSummarizerConnectionSettings: mocks.resolveFallbackSummarizerConnectionSettings,
    resolveSummarizerConnectionSettings: (settings) => settings,
    sendSummarizerRequest: (requestOrSettings, ...legacyArgs) => {
        if (requestOrSettings?.settings) {
            return mocks.sendSummarizerRequest(
                requestOrSettings.settings,
                requestOrSettings.systemPrompt,
                requestOrSettings.userPrompt,
                requestOrSettings.signal,
                requestOrSettings.metadata,
            );
        }
        return mocks.sendSummarizerRequest(requestOrSettings, ...legacyArgs);
    },
}));

const VALID_L0_SUMMARY = [
    '[NARRATIVE]',
    'The source passage was summarized into a concise memory.',
    '',
    '[STATE]',
    'current_date_time: 2024-12-03 06 Wed',
    'timeline_start: 2024-12-03 06 Wed',
    'timeline_end: 2024-12-03 06 Wed',
].join('\n');

function customPromptSettings(settings) {
    const presets = {};
    if (Object.hasOwn(settings, 'summarizerSystemPrompt')) {
        presets.summarizerSystemPromptPreset = 'custom';
    }
    if (Object.hasOwn(settings, 'summarizerUserPrompt')) {
        presets.promptPreset = 'custom';
    }
    if (Object.hasOwn(settings, 'summarizerRepairPrompt')) {
        presets.summarizerRepairPromptPreset = 'custom';
    }
    if (Object.hasOwn(settings, 'promotionSystemPrompt')) {
        presets.promotionSystemPromptPreset = 'custom';
    }
    if (Object.hasOwn(settings, 'promotionUserPrompt')) {
        presets.promotionPromptPreset = 'custom';
    }
    if (Object.hasOwn(settings, 'promotionRepairPrompt')) {
        presets.promotionRepairPromptPreset = 'custom';
    }
    return { uiMode: 'advanced', enabled: true, ...presets, ...settings };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    installSillyTavernStub({
        settings: customPromptSettings({
            summarizerSystemPrompt: 'SYS',
            summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
            promotionSystemPrompt: 'PROMO_SYS',
            promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
            stripPatterns: [],
            stripChineseIdeographs: false,
        }),
    });
    mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue(null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('callSummarizer abort signal plumbing', () => {
    it('passes an attempt abort signal to the configured connection provider', async () => {
        let receivedSignal;
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, signal) => {
                receivedSignal = signal;
                return 'summary text';
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(callSummarizer('source passage', 'prior context')).resolves.toBe(
            'summary text',
        );

        expect(receivedSignal).toBeInstanceOf(AbortSignal);
        expect(receivedSignal.aborted).toBe(false);
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledWith(
            expect.any(Object),
            'SYS',
            'CTX prior context STORY source passage',
            receivedSignal,
            expect.any(Object),
        );
    });

    it('preserves Layer 0 dual-track structural markers in the cleaned result', async () => {
        const summary = '[NARRATIVE]\nScene summary.\n\n[STATE]\nlocation: dock';
        mocks.sendSummarizerRequest.mockResolvedValue(summary);

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(
            callSummarizer('source passage', 'prior context', {
                kind: 'layer0',
            }),
        ).resolves.toBe(summary);
    });

    it('uses promotion prompts for promotion calls', async () => {
        installSillyTavernStub({
            settings: customPromptSettings({
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'L0 {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            }),
        });
        mocks.sendSummarizerRequest.mockResolvedValue('summary text');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(
            callSummarizer('merged snippets', 'deep context', {
                kind: 'promotion',
                layerIndex: 0,
                mergedSnippetCount: 3,
            }),
        ).resolves.toBe('summary text');

        expect(mocks.sendSummarizerRequest).toHaveBeenCalledWith(
            expect.any(Object),
            'PROMO_SYS',
            expect.stringContaining('PROMO deep context MEMORY merged snippets'),
            expect.any(AbortSignal),
            expect.objectContaining({ kind: 'promotion' }),
        );
        const prompt = mocks.sendSummarizerRequest.mock.calls[0][2];
        expect(prompt).toContain('<summaryception_promotion_constraints>');
        expect(prompt).toContain('Soft target: about 2 tokens');
        expect(prompt).toContain('Hard maximum: 2 tokens');
        expect(prompt).toContain('40% of the source narratives');
        expect(prompt).toContain('Deduplicate related events');
    });

    it('uses promotion repair prompts for promotion repair calls', async () => {
        installSillyTavernStub({
            settings: customPromptSettings({
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'L0 {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                promotionRepairPrompt: 'PROMO_REPAIR {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            }),
        });
        mocks.sendSummarizerRequest.mockResolvedValue('summary text');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(
            callSummarizer('merged snippets', 'deep context', {
                kind: 'promotion',
                promotionRepair: {
                    outputTokens: 500,
                    targetTokens: 200,
                    hardMaxTokens: 300,
                    rejectedSummary: 'Rejected verbose summary.',
                },
            }),
        ).resolves.toBe('summary text');

        expect(mocks.sendSummarizerRequest).toHaveBeenCalledWith(
            expect.any(Object),
            'PROMO_SYS',
            expect.stringContaining('PROMO_REPAIR deep context MEMORY merged snippets'),
            expect.any(AbortSignal),
            expect.objectContaining({ kind: 'promotion' }),
        );
        const prompt = mocks.sendSummarizerRequest.mock.calls[0][2];
        expect(prompt).toContain('Repair task');
        expect(prompt).toContain('Rejected verbose summary.');
    });

    it('preserves dual-track structural markers in promotion output for state parsing', async () => {
        mocks.sendSummarizerRequest.mockResolvedValue(
            '[NARRATIVE]\nMerged summary.\n[STATE]\nlocation: dock',
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(
            callSummarizer('merged snippets', 'deep context', {
                kind: 'promotion',
                layerIndex: 0,
                mergedSnippetCount: 3,
            }),
        ).resolves.toBe('[NARRATIVE]\nMerged summary.\n[STATE]\nlocation: dock');
    });

    it('adds runtime compression constraints to Layer 0 and promotion prompts', async () => {
        installSillyTavernStub({
            settings: customPromptSettings({
                layer0SummaryTokenTarget: 120,
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'CUSTOM {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            }),
        });
        mocks.sendSummarizerRequest
            .mockResolvedValueOnce(VALID_L0_SUMMARY)
            .mockResolvedValueOnce('summary text');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [0, 1],
            assistantTurnCount: 1,
        });
        await callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 0,
            mergedSnippetCount: 3,
        });

        const layer0Prompt = mocks.sendSummarizerRequest.mock.calls[0][2];
        expect(layer0Prompt).toContain(
            '[NARRATIVE] target: about 120 tokens; never exceed 180 tokens',
        );
        expect(layer0Prompt).toContain('This passage covers chat messages 0-1');
        expect(layer0Prompt).toContain('Message 1 is the latest summarized message');
        expect(layer0Prompt).toContain('current_date_time');
        expect(layer0Prompt).not.toContain('timeline_start');
        expect(layer0Prompt).toContain('YYYY-MM-DD HH ddd');
        expect(layer0Prompt).toContain('drop minutes');
        expect(layer0Prompt).toContain('physiological or sex counters');

        const promotionPrompt = mocks.sendSummarizerRequest.mock.calls[1][2];
        expect(promotionPrompt).toContain('PROMO deep context MEMORY merged snippets');
        expect(promotionPrompt).toContain('<summaryception_promotion_constraints>');
        expect(promotionPrompt).toContain('Soft target: about 2 tokens');
        expect(promotionPrompt).toContain('Hard maximum: 2 tokens');
        expect(promotionPrompt).toContain('[msgs 100-120; current 2024-12-03 09 Wed]');
        expect(promotionPrompt).toContain('Do not invent broad dates for unknown spans');
        expect(promotionPrompt).toContain('Do not repeat or re-summarize events');
    });

    it('switches Layer 0 validation retries to the repair prompt', async () => {
        vi.useFakeTimers();
        installSillyTavernStub({
            settings: customPromptSettings({
                layer0SummaryTokenTarget: 120,
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'L0 {{context_str}} STORY {{story_txt}}',
                summarizerRepairPrompt: 'L0_REPAIR {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
                stripChineseIdeographs: false,
            }),
        });
        mocks.sendSummarizerRequest
            .mockResolvedValueOnce('invalid unstructured output')
            .mockResolvedValueOnce(VALID_L0_SUMMARY);

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const resultPromise = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
            sourceRange: [0, 1],
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe(VALID_L0_SUMMARY);
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        expect(mocks.sendSummarizerRequest.mock.calls[0][2]).toContain(
            'L0 prior context STORY source passage',
        );
        expect(mocks.sendSummarizerRequest.mock.calls[1][2]).toContain(
            'L0_REPAIR prior context STORY source passage',
        );
        expect(mocks.sendSummarizerRequest.mock.calls[1][4]).toMatchObject({
            kind: 'layer0',
            layer0Repair: true,
        });
    });

    it('routes through fallback after primary retry exhaustion', async () => {
        vi.useFakeTimers();
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
        });
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return VALID_L0_SUMMARY;
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const resultPromise = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe(VALID_L0_SUMMARY);
        expect(
            mocks.sendSummarizerRequest.mock.calls.some((call) => call[4]?.useFallback === true),
        ).toBe(true);
    });

    it('does not use fallback after a non-retryable primary failure', async () => {
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
        });
        mocks.sendSummarizerRequest.mockRejectedValue(new Error('bad config'));

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(callSummarizer('source passage', 'prior context')).resolves.toBe('');
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(1);
        expect(
            mocks.sendSummarizerRequest.mock.calls.some((call) => call[4]?.useFallback === true),
        ).toBe(false);
    });

    it('uses the promotion merge route before falling back for promotion calls', async () => {
        vi.useFakeTimers();
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'openai',
            openaiModel: 'backup-model',
        });
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return 'backup promotion';
                }
                throw new Error('Request timed out after 120s');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const resultPromise = callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 0,
            mergedSnippetCount: 3,
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe('backup promotion');
        expect(mocks.sendSummarizerRequest.mock.calls[0][4]).toMatchObject({
            kind: 'promotion',
            layerIndex: 0,
        });
        expect(
            mocks.sendSummarizerRequest.mock.calls.some(
                (call) => call[4]?.kind === 'promotion' && call[4]?.useFallback === true,
            ),
        ).toBe(true);
    });

    it('uses one primary probe after the same bucket exhausts retries', async () => {
        vi.useFakeTimers();
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
        });
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return VALID_L0_SUMMARY;
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const firstRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(firstRun).resolves.toBe(VALID_L0_SUMMARY);

        const callsAfterFirstRun = mocks.sendSummarizerRequest.mock.calls.length;
        const secondRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await expect(secondRun).resolves.toBe(VALID_L0_SUMMARY);

        const secondRunCalls = mocks.sendSummarizerRequest.mock.calls.slice(callsAfterFirstRun);
        const secondRunPrimaryCalls = secondRunCalls.filter((call) => !call[4]?.useFallback);
        const secondRunFallbackCalls = secondRunCalls.filter((call) => call[4]?.useFallback);
        expect(secondRunPrimaryCalls).toHaveLength(1);
        expect(secondRunFallbackCalls).toHaveLength(1);
    });

    it('keeps Layer 0 and L1+ primary health buckets separate', async () => {
        vi.useFakeTimers();
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
        });
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return metadata.kind === 'layer0' ? VALID_L0_SUMMARY : 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const layer0Run = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(layer0Run).resolves.toBe(VALID_L0_SUMMARY);

        const callsAfterLayer0 = mocks.sendSummarizerRequest.mock.calls.length;
        const promotionRun = callSummarizer('merged snippets', 'deep context', {
            kind: 'promotion',
            layerIndex: 0,
            mergedSnippetCount: 3,
        });
        await vi.runAllTimersAsync();
        await expect(promotionRun).resolves.toBe('backup summary');

        const promotionCalls = mocks.sendSummarizerRequest.mock.calls.slice(callsAfterLayer0);
        const promotionPrimaryCalls = promotionCalls.filter((call) => !call[4]?.useFallback);
        expect(promotionPrimaryCalls).toHaveLength(4);
    });

    it('clears an unhealthy bucket when the primary answers', async () => {
        vi.useFakeTimers();
        mocks.resolveFallbackSummarizerConnectionSettings.mockReturnValue({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
        });
        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return VALID_L0_SUMMARY;
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const firstRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(firstRun).resolves.toBe(VALID_L0_SUMMARY);

        mocks.sendSummarizerRequest.mockResolvedValueOnce(VALID_L0_SUMMARY);
        await expect(
            callSummarizer('source passage', 'prior context', {
                kind: 'layer0',
            }),
        ).resolves.toBe(VALID_L0_SUMMARY);

        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return VALID_L0_SUMMARY;
                }
                throw new Error('timeout');
            },
        );

        const callsBeforeFinalRun = mocks.sendSummarizerRequest.mock.calls.length;
        const finalRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(finalRun).resolves.toBe(VALID_L0_SUMMARY);

        const finalRunCalls = mocks.sendSummarizerRequest.mock.calls.slice(callsBeforeFinalRun);
        const finalRunPrimaryCalls = finalRunCalls.filter((call) => !call[4]?.useFallback);
        expect(finalRunPrimaryCalls).toHaveLength(4);
    });

    it('retries when Strip CN sees more than ten percent Chinese ideographs', async () => {
        vi.useFakeTimers();
        installSillyTavernStub({
            settings: customPromptSettings({
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
                stripChineseIdeographs: true,
            }),
        });
        mocks.sendSummarizerRequest
            .mockResolvedValueOnce('漢字漢字漢字 ok')
            .mockResolvedValueOnce('clean summary');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const resultPromise = callSummarizer('source passage', 'prior context');
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe('clean summary');
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith(
            expect.stringContaining('too much CN text'),
            'Summaryception',
            expect.any(Object),
        );
    });

    it('strips Chinese ideographs without retrying at exactly ten percent', async () => {
        installSillyTavernStub({
            settings: customPromptSettings({
                summarizerSystemPrompt: 'SYS',
                summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
                stripPatterns: [],
                stripChineseIdeographs: true,
            }),
        });
        mocks.sendSummarizerRequest.mockResolvedValue('漢abcdefghi');

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        await expect(callSummarizer('source passage', 'prior context')).resolves.toBe('abcdefghi');
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(1);
    });
});
