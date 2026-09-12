import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import { summarizeBatchFromTurns } from '../src/core/summarizer-batch.js';
import {
    installBrowserRuntimeStub,
    installSummaryContext,
    makeMessage,
    makeSummaryStore,
} from './test-helpers.js';

describe('Layer 0 deferred cleanup commit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    function buildChat() {
        return [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
    }

    it('shows one start toast and a completion toast after commit', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const chat = buildChat();
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });

        await expect(summarizeBatchFromTurns([{ index: 1 }], { showToasts: true })).resolves.toBe(
            true,
        );

        expect(toastr.info).toHaveBeenCalledOnce();
        expect(toastr.info).toHaveBeenCalledWith(
            'Updating conversation memory…',
            'Summaryception',
            {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                progressBar: true,
            },
        );
        expect(toastr.clear).toHaveBeenCalledOnce();
        expect(toastr.success).toHaveBeenCalledWith(
            'Conversation memory updated.',
            'Summaryception',
            { timeOut: 3000 },
        );
    });
    it('assigns missing IDs on the live chat before capturing the source snapshot', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('assistant-id');
        const chat = buildChat();
        delete chat[1].sc_id;
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });

        await expect(summarizeBatchFromTurns([{ index: 1 }])).resolves.toBe(true);

        expect(metadata.summaryception.layers[0][0].sourceMessageIds).toEqual([
            'user-id',
            'assistant-id',
        ]);
    });

    it('keeps all chat records intact while the summary runs and commits', async () => {
        const chat = buildChat();
        const metadata = { summaryception: makeSummaryStore() };
        const saveMetadata = vi.fn(async () => {});
        const saveChat = vi.fn(async () => {});
        const reloadCurrentChat = vi.fn(async () => {});
        let resolveSummary;
        callSummarizer.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSummary = resolve;
                }),
        );
        installSummaryContext({
            chat,
            metadata,
            saveMetadata,
            saveChat,
            reloadCurrentChat,
        });

        const resultPromise = summarizeBatchFromTurns([{ index: 1 }]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(saveChat).not.toHaveBeenCalled();
        resolveSummary({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });
        await expect(resultPromise).resolves.toBe(true);

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(metadata.summaryception.layers[0]).toHaveLength(1);
        expect(saveChat).not.toHaveBeenCalled();
        expect(reloadCurrentChat).not.toHaveBeenCalled();
        expect(saveMetadata).toHaveBeenCalled();
    });

    it('restores chat and Layer 0 when post-mutation persistence fails', async () => {
        const chat = buildChat();
        const originalChat = [...chat];
        const metadata = { summaryception: makeSummaryStore() };
        let metadataSaves = 0;
        const saveMetadata = vi.fn(async () => {
            metadataSaves++;
            if (metadataSaves === 2) {
                throw new Error('metadata write failed');
            }
        });
        installSummaryContext({ chat, metadata, saveMetadata });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });
        await expect(summarizeBatchFromTurns([{ index: 1 }])).rejects.toThrow(
            'metadata write failed',
        );

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});

describe('Layer 0 request outcome handling', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    it.each([['aborted'], ['blocked'], ['failed']])(
        'skips the commit when the request outcome is %s',
        async (status) => {
            const chat = [
                makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
                makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
            ];
            const metadata = { summaryception: makeSummaryStore() };
            installSummaryContext({ chat, metadata });
            callSummarizer.mockResolvedValue({ status });

            await expect(summarizeBatchFromTurns([{ index: 1 }])).resolves.toBe(false);

            expect(metadata.summaryception.layers[0]).toEqual([]);
            expect(metadata.summaryception.mutationEpoch).toBe(0);
        },
    );
});
