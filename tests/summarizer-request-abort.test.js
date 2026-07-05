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
});
