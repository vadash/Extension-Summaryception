import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    installBrowserRuntimeStub,
    installSillyTavernStub,
    makeMessage,
    makeSummaryStore,
} from './test-helpers.js';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
});

function summaryMetadata(store) {
    return { summaryception: makeSummaryStore(store) };
}

describe('snippet editing', () => {
    it('updates snippet text through chat metadata and refreshes injection', async () => {
        const ctx = installSnippetContext({
            metadata: summaryMetadata({ layers: [[{ text: 'old summary' }]] }),
        });
        const { snippetManager, mocks } = await loadSnippetManager();

        await expect(snippetManager.updateSnippetTextAt(0, 0, '  new summary  ')).resolves.toEqual({
            status: 'updated',
        });
        await expect(snippetManager.updateSnippetTextAt(0, 0, 'new summary')).resolves.toEqual({
            status: 'unchanged',
        });
        await expect(snippetManager.updateSnippetTextAt(0, 0, '   ')).resolves.toEqual({
            status: 'empty',
        });
        await expect(snippetManager.updateSnippetTextAt(0, 9, 'missing')).resolves.toEqual({
            status: 'missing',
        });

        expect(ctx.chatMetadata.summaryception.layers[0][0].text).toBe('new summary');
        expect(ctx.saveMetadata).toHaveBeenCalledTimes(1);
        expect(mocks.updateInjection).toHaveBeenCalledTimes(1);
    });
});

describe('snippet deletion', () => {
    it('deletes Layer 0 snippets, recalculates contiguous coverage, and unghosts the source range', async () => {
        const slash = vi.fn(async () => {});
        const saveChat = vi.fn(async () => {});
        const ctx = installSnippetContext({
            chat: [
                makeMessage({ ghosted: true, isHidden: true }),
                makeMessage({ ghosted: true, isHidden: true }),
                makeMessage({ ghosted: true, isHidden: true }),
                makeMessage({ ghosted: true, isHidden: true }),
            ],
            metadata: summaryMetadata({
                layers: [
                    [
                        { text: 'first', turnRange: [0, 1] },
                        { text: 'second', turnRange: [2, 3] },
                    ],
                ],
                summarizedUpTo: 3,
                ghostedIndices: [0, 1, 2, 3],
            }),
            executeSlashCommandsWithOptions: slash,
            saveChat,
        });
        const { snippetManager, mocks } = await loadSnippetManager();

        await expect(snippetManager.deleteSnippetAt(0, 0)).resolves.toEqual({
            status: 'deleted',
            layerIndex: 0,
        });

        expect(ctx.chatMetadata.summaryception.layers[0]).toEqual([
            { text: 'second', turnRange: [2, 3] },
        ]);
        expect(ctx.chatMetadata.summaryception.summarizedUpTo).toBe(-1);
        expect(ctx.chatMetadata.summaryception.ghostedIndices).toEqual([2, 3]);
        expect(ctx.chat[0].extra.sc_ghosted).toBeUndefined();
        expect(ctx.chat[1].extra.sc_ghosted).toBeUndefined();
        expect(ctx.chat[2].extra.sc_ghosted).toBe(true);
        expect(slash).toHaveBeenCalledWith('/unhide 0-1', { showOutput: false });
        expect(saveChat).toHaveBeenCalledTimes(1);
        expect(mocks.updateInjection).toHaveBeenCalledTimes(1);
    });
});

describe('snippet regeneration', () => {
    it('regenerates Layer 0 snippets with surrounding snippet context', async () => {
        const ctx = installSnippetContext({
            chat: [makeMessage({ mes: 'Alpha' }), makeMessage({ mes: 'Beta' })],
            metadata: summaryMetadata({
                layers: [
                    [
                        { text: 'old summary', turnRange: [0, 1] },
                        { text: 'other context', turnRange: [2, 3] },
                    ],
                    [{ text: 'meta context', mergedCount: 2, fromLayer: 0 }],
                ],
                summarizedUpTo: 3,
            }),
        });
        const { snippetManager, mocks } = await loadSnippetManager();
        mocks.callSummarizer.mockResolvedValue('new summary');

        const result = await snippetManager.regenerateSnippetAt(0, 0);

        expect(result).toEqual({ status: 'regenerated', range: [0, 1] });
        expect(mocks.withUsageRun).toHaveBeenCalledWith(
            'snippet regeneration',
            expect.any(Function),
        );
        expect(mocks.callSummarizer).toHaveBeenCalledWith(
            'Assistant: Alpha\nAssistant: Beta',
            'meta context other context',
            expect.objectContaining({
                kind: 'regenerate',
                sourceRange: [0, 1],
                regexStats: expect.any(Object),
            }),
        );
        expect(mocks.setSummarizing).toHaveBeenNthCalledWith(1, true);
        expect(mocks.setSummarizing).toHaveBeenNthCalledWith(2, false);
        expect(ctx.chatMetadata.summaryception.layers[0][0]).toMatchObject({
            text: 'new summary',
            regenerated: true,
        });
        expect(ctx.chatMetadata.summaryception.layers[0][0].timestamp).toEqual(expect.any(Number));
        expect(mocks.updateInjection).toHaveBeenCalledTimes(1);
    });

    it('returns busy without starting a usage run', async () => {
        installSnippetContext({
            metadata: summaryMetadata({
                layers: [[{ text: 'old summary', turnRange: [0, 0] }]],
                summarizedUpTo: 0,
            }),
        });
        const { snippetManager, mocks } = await loadSnippetManager();
        mocks.getIsSummarizing.mockReturnValue(true);

        await expect(snippetManager.regenerateSnippetAt(0, 0)).resolves.toEqual({
            status: 'busy',
        });

        expect(mocks.withUsageRun).not.toHaveBeenCalled();
        expect(mocks.setSummarizing).not.toHaveBeenCalled();
    });

    it('rejects unsupported or missing regeneration targets', async () => {
        installSnippetContext({
            metadata: summaryMetadata({
                layers: [[], [{ text: 'meta summary', turnRange: [0, 0] }]],
            }),
        });
        const { snippetManager } = await loadSnippetManager();

        await expect(snippetManager.regenerateSnippetAt(1, 0)).resolves.toEqual({
            status: 'unsupported',
        });
        await expect(snippetManager.regenerateSnippetAt(0, 0)).resolves.toEqual({
            status: 'missing',
        });
    });

    it('keeps the original snippet when source text is empty or summarizer fails', async () => {
        const ctx = installSnippetContext({
            chat: [makeMessage({ mes: '   ' }), makeMessage({ mes: 'usable source' })],
            metadata: summaryMetadata({
                layers: [
                    [
                        { text: 'empty source', turnRange: [0, 0] },
                        { text: 'failed source', turnRange: [1, 1] },
                    ],
                ],
                summarizedUpTo: 1,
            }),
        });
        const { snippetManager, mocks } = await loadSnippetManager();
        mocks.callSummarizer.mockResolvedValue('');

        await expect(snippetManager.regenerateSnippetAt(0, 0)).resolves.toEqual({
            status: 'empty-source',
        });
        await expect(snippetManager.regenerateSnippetAt(0, 1)).resolves.toEqual({
            status: 'failed',
        });

        expect(ctx.chatMetadata.summaryception.layers[0][0].text).toBe('empty source');
        expect(ctx.chatMetadata.summaryception.layers[0][1].text).toBe('failed source');
        expect(mocks.updateInjection).not.toHaveBeenCalled();
        expect(mocks.callSummarizer).toHaveBeenCalledTimes(1);
    });
});

function installSnippetContext(options = {}) {
    const ctx = installSillyTavernStub({
        settings: { applyRegexScripts: false },
        ...options,
    });
    ctx.saveMetadata = vi.fn(async () => {});
    return ctx;
}

async function loadSnippetManager() {
    const mocks = {
        callSummarizer: vi.fn(),
        getIsSummarizing: vi.fn(() => false),
        setSummarizing: vi.fn(),
        updateInjection: vi.fn(),
        withUsageRun: vi.fn(async (_label, callback) => await callback()),
    };

    vi.doMock('../src/core/summarizer.js', () => ({
        callSummarizer: mocks.callSummarizer,
        getIsSummarizing: mocks.getIsSummarizing,
        setSummarizing: mocks.setSummarizing,
    }));
    vi.doMock('../src/core/summarizer-usage.js', () => ({
        withUsageRun: mocks.withUsageRun,
    }));
    vi.doMock('../src/features/injection.js', () => ({
        updateInjection: mocks.updateInjection,
    }));

    return {
        snippetManager: await import('../src/features/snippet-manager.js'),
        mocks,
    };
}
