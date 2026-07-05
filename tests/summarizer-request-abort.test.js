import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeStub, installSillyTavernStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));

vi.mock('../src/core/connectionutil.js', () => ({
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
            stripPatterns: [],
        },
    });
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
});
