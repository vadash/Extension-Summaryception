import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import {
    summarizeAtomicLayer0Partitions,
    summarizeBatchFromTurns,
} from '../src/core/summarizer-batch.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    installSummaryContext,
    makeMessage,
    makeNotifyRecorder,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

/** Minimal valid summary passage returned by the stubbed request layer. */
const VALID_SUMMARY = '[NARRATIVE]\nA concise summary.\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * Completed outcome carrying the profile the real request layer resolves from
 * the dispatch metadata the batch builds.
 */
function completedOutcome(metadata) {
    return {
        status: 'completed',
        text: VALID_SUMMARY,
        profile: resolveCallProfile(makeSummarySettings(), metadata),
    };
}

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

    /** Run one single-turn batch through the default entry. */
    function runBatch(recorder) {
        return summarizeBatchFromTurns([{ index: 1 }], {}, recorder);
    }

    it('notifies one batch progress lifecycle and closes it with success', async () => {
        const recorder = makeNotifyRecorder();
        const chat = buildChat();
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        let progressOpenAtRequest = false;
        callSummarizer.mockImplementation(async (_story, _context, metadata) => {
            progressOpenAtRequest = recorder.events.some((event) => event.type === 'progress');
            return completedOutcome(metadata);
        });

        await expect(runBatch(recorder)).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

        expect(progressOpenAtRequest).toBe(true);
        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(1);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-updated' });
    });

    it.each([
        ['aborted', 'batch-memory-aborted'],
        ['blocked', 'batch-memory-failed'],
        ['failed', 'batch-memory-failed'],
    ])(
        'closes the batch progress with a %s terminal and skips the commit',
        async (status, terminalKind) => {
            const recorder = makeNotifyRecorder();
            const chat = buildChat();
            const metadata = { summaryception: makeSummaryStore() };
            installSummaryContext({ chat, metadata });
            callSummarizer.mockResolvedValue({ status });

            await expect(runBatch(recorder)).resolves.toEqual({ status: 'failed' });

            const progress = recorder.events.filter((event) => event.type === 'progress');
            expect(progress).toHaveLength(1);
            expect(progress[0].label).toBe('batch-memory');
            expect(recorder.events.filter((event) => event.type === 'update')).toHaveLength(0);
            const clears = recorder.events.filter((event) => event.type === 'clear');
            expect(clears).toHaveLength(1);
            expect(clears[0].handle).toBe(progress[0].handle);
            expect(clears[0].event).toEqual({ kind: terminalKind });
            expect(metadata.summaryception.layers[0]).toEqual([]);
            expect(metadata.summaryception.mutationEpoch).toBe(0);
        },
    );

    it('emits no progress events when the passage never validates', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: '' }),
            makeMessage({ scId: 'assistant-id', mes: '' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: VALID_SUMMARY,
        });

        await expect(runBatch(recorder)).resolves.toEqual({
            status: 'idle',
        });

        expect(callSummarizer).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([]);
    });
    it('assigns missing IDs on the live chat before capturing the source snapshot', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('assistant-id');
        const chat = buildChat();
        delete chat[1].sc_id;
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(
            async (_story, _context, metadata) => await completedOutcome(metadata),
        );

        await expect(runBatch()).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

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
        /** @type {object} */
        let dispatchMetadata;
        callSummarizer.mockImplementation((_story, _context, metadata) => {
            dispatchMetadata = metadata;
            return new Promise((resolve) => {
                resolveSummary = resolve;
            });
        });
        installSummaryContext({
            chat,
            metadata,
            saveMetadata,
            saveChat,
            reloadCurrentChat,
        });

        const resultPromise = runBatch();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(saveChat).not.toHaveBeenCalled();
        resolveSummary(completedOutcome(dispatchMetadata));
        await expect(resultPromise).resolves.toEqual({ status: 'completed', completed: 1 });

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(metadata.summaryception.layers[0]).toHaveLength(1);
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
            if (metadataSaves === 1) {
                throw new Error('metadata write failed');
            }
        });
        installSummaryContext({ chat, metadata, saveMetadata });
        callSummarizer.mockImplementation(
            async (_story, _context, metadata) => await completedOutcome(metadata),
        );
        await expect(runBatch()).rejects.toThrow('metadata write failed');

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });

    it('fails the batch and skips the commit when the profile guard rejects a headerless summary', async () => {
        const chat = buildChat();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async (_story, _context, dispatchMetadata) => ({
            status: 'completed',
            text: 'A headerless summary paragraph.',
            profile: resolveCallProfile(makeSummarySettings(), dispatchMetadata),
        }));

        await expect(runBatch(makeNotifyRecorder())).resolves.toEqual({ status: 'failed' });

        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});

describe('Layer 0 atomic multi-partition progress', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    it('closes the shared progress exactly once when a later partition fails validation', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: 'assistant-id-2', mes: 'Second assistant scene.' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer
            .mockImplementationOnce(
                async (_story, _context, metadata) => await completedOutcome(metadata),
            )
            .mockImplementationOnce(async () => ({ status: 'aborted' }));
        const partitions = [
            { turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 },
            { turns: [{ index: 3 }], sourceStartIdx: 3, sourceEndIdx: 3 },
        ];

        await expect(summarizeAtomicLayer0Partitions(partitions, {}, recorder)).resolves.toEqual({
            status: 'failed',
            completed: 1,
            failed: 1,
        });

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(2);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it('settles the shared progress when a later partition fails to capture its snapshot', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: undefined, mes: 'Second assistant scene.' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer.mockImplementation(
            async (_story, _context, metadata) => await completedOutcome(metadata),
        );
        const partitions = [
            { turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 },
            { turns: [{ index: 3 }], sourceStartIdx: 3, sourceEndIdx: 3 },
        ];

        await expect(summarizeAtomicLayer0Partitions(partitions, {}, recorder)).rejects.toThrow(
            'Cannot summarize messages without stable Summaryception IDs.',
        );

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-failed' });
    });

    it('aborts remaining partitions when the store mutates mid-run', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: 'assistant-id-2', mes: 'Second assistant scene.' }),
        ];
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async (_story, _context, dispatchMetadata) => {
            metadata.summaryception.mutationEpoch += 1;
            return completedOutcome(dispatchMetadata);
        });
        const partitions = [
            { turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 },
            { turns: [{ index: 3 }], sourceStartIdx: 3, sourceEndIdx: 3 },
        ];

        await expect(summarizeAtomicLayer0Partitions(partitions, {}, recorder)).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it('aborts remaining partitions when the chat switches mid-run', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: 'assistant-id-2', mes: 'Second assistant scene.' }),
        ];
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async (_story, _context, metadata) => {
            installSummaryContext({
                chat: [makeMessage({ scId: 'other-chat', mes: 'Other chat.' })],
                metadata,
            });
            return completedOutcome(metadata);
        });
        const partitions = [
            { turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 },
            { turns: [{ index: 3 }], sourceStartIdx: 3, sourceEndIdx: 3 },
        ];

        await expect(
            summarizeAtomicLayer0Partitions(partitions, {}, makeNotifyRecorder()),
        ).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('restores chat and Layer 0 when atomic post-mutation persistence fails', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
        const originalChat = [...chat];
        const metadata = { summaryception: makeSummaryStore() };
        let metadataSaves = 0;
        const saveMetadata = vi.fn(async () => {
            metadataSaves++;
            if (metadataSaves === 1) {
                throw new Error('metadata write failed');
            }
        });
        installSummaryContext({ chat, metadata, saveMetadata });
        callSummarizer.mockImplementation(
            async (_story, _context, metadata) => await completedOutcome(metadata),
        );
        const partitions = [{ turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 }];

        await expect(summarizeAtomicLayer0Partitions(partitions, {}, undefined)).rejects.toThrow(
            'metadata write failed',
        );

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});
