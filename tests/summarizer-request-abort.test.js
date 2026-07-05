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
    sendSummarizerRequest: mocks.sendSummarizerRequest,
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    installSillyTavernStub({
        settings: {
            summarizerSystemPrompt: 'SYS',
            summarizerUserPrompt: 'CTX {{context_str}} STORY {{story_txt}}',
            promotionSystemPrompt: 'PROMO_SYS',
            promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
            stripPatterns: [],
        },
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

    it('uses promotion prompts for promotion calls', async () => {
        installSillyTavernStub({
            settings: {
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'L0 {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            },
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
            'PROMO deep context MEMORY merged snippets',
            expect.any(AbortSignal),
            expect.objectContaining({ kind: 'promotion' }),
        );
    });

    it('adds Layer 0 compression constraints without changing promotion prompts', async () => {
        installSillyTavernStub({
            settings: {
                layer0SummaryTokenTarget: 120,
                summarizerSystemPrompt: 'L0_SYS',
                summarizerUserPrompt: 'CUSTOM {{context_str}} STORY {{story_txt}}',
                promotionSystemPrompt: 'PROMO_SYS',
                promotionUserPrompt: 'PROMO {{context_str}} MEMORY {{story_txt}}',
                stripPatterns: [],
            },
        });
        mocks.sendSummarizerRequest.mockResolvedValue('summary text');

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
        expect(layer0Prompt).toContain('Target length: at most about 120 tokens');
        expect(layer0Prompt).toContain('Saturday Oct 19, 7PM');
        expect(layer0Prompt).toContain('8AM or 7PM');
        expect(layer0Prompt).toContain('avoid minute tracking unless essential');
        expect(layer0Prompt).toContain('absolute date/time can be inferred');
        expect(layer0Prompt).toContain('future goals/plans');
        expect(mocks.sendSummarizerRequest.mock.calls[1][2]).toBe(
            'PROMO deep context MEMORY merged snippets',
        );
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
                    return 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const resultPromise = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe('backup summary');
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
                    return 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const firstRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(firstRun).resolves.toBe('backup summary');

        const callsAfterFirstRun = mocks.sendSummarizerRequest.mock.calls.length;
        const secondRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await expect(secondRun).resolves.toBe('backup summary');

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
                    return 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const layer0Run = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(layer0Run).resolves.toBe('backup summary');

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
        expect(promotionPrimaryCalls).toHaveLength(6);
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
                    return 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const { callSummarizer } = await import('../src/core/summarizer-request.js');

        const firstRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(firstRun).resolves.toBe('backup summary');

        mocks.sendSummarizerRequest.mockResolvedValueOnce('primary recovered');
        await expect(
            callSummarizer('source passage', 'prior context', {
                kind: 'layer0',
            }),
        ).resolves.toBe('primary recovered');

        mocks.sendSummarizerRequest.mockImplementation(
            async (_settings, _system, _prompt, _signal, metadata) => {
                if (metadata.useFallback) {
                    return 'backup summary';
                }
                throw new Error('timeout');
            },
        );

        const callsBeforeFinalRun = mocks.sendSummarizerRequest.mock.calls.length;
        const finalRun = callSummarizer('source passage', 'prior context', {
            kind: 'layer0',
        });
        await vi.runAllTimersAsync();
        await expect(finalRun).resolves.toBe('backup summary');

        const finalRunCalls = mocks.sendSummarizerRequest.mock.calls.slice(callsBeforeFinalRun);
        const finalRunPrimaryCalls = finalRunCalls.filter((call) => !call[4]?.useFallback);
        expect(finalRunPrimaryCalls).toHaveLength(6);
    });
});
