import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import { runLayer0 } from '../src/core/layer0-run.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { SUMMARY_COMMIT_MODES } from '../src/core/summarization-routes.js';
import {
    beginForegroundGeneration,
    endForegroundGeneration,
    resetCommitStateForTests,
} from '../src/core/summarizer-commit.js';
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
 * the dispatch metadata the run builds.
 */
function completedOutcome(metadata) {
    return {
        status: 'completed',
        text: VALID_SUMMARY,
        profile: resolveCallProfile(makeSummarySettings(), metadata),
    };
}

/** The standard route: the whole selection commits as one Passage. */
function onePassagePlan(overrides = {}) {
    return {
        commitMode: SUMMARY_COMMIT_MODES.TURNS,
        batchTurns: [{ index: 1 }],
        partitions: [],
        ...overrides,
    };
}

/** The cache-friendly route: every partition commits as one transaction. */
function atomicPlan(partitions) {
    return {
        commitMode: SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS,
        batchTurns: partitions.flatMap((entry) => entry.turns),
        partitions,
    };
}

function partition(sourceStartIdx, sourceEndIdx) {
    return { turns: [{ index: sourceEndIdx }], sourceStartIdx, sourceEndIdx };
}

/** One user turn plus one assistant turn, the smallest Passage there is. */
function buildChat() {
    return [
        makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
        makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
    ];
}

function progressEvents(recorder) {
    return recorder.events.filter((event) => event.type === 'progress');
}

function clearEvents(recorder) {
    return recorder.events.filter((event) => event.type === 'clear');
}

describe('Layer 0 run — one Passage', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        resetCommitStateForTests();
    });

    function runOnePassage(recorder) {
        return runLayer0(onePassagePlan(), recorder);
    }

    it('commits one Passage and reports completed', async () => {
        const recorder = makeNotifyRecorder();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat: buildChat(), metadata });
        let progressOpenAtRequest = false;
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) => {
            progressOpenAtRequest = recorder.events.some((event) => event.type === 'progress');
            return completedOutcome(dispatchMetadata);
        });

        await expect(runOnePassage(recorder)).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

        expect(progressOpenAtRequest).toBe(true);
        const progress = progressEvents(recorder);
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(1);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = clearEvents(recorder);
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-updated' });
        expect(metadata.summaryception.layers[0]).toHaveLength(1);
    });

    it.each([
        ['aborted', 'batch-memory-aborted', { status: 'aborted', completed: 0 }],
        ['blocked', 'batch-memory-failed', { status: 'failed', completed: 0, failed: 1 }],
        ['failed', 'batch-memory-failed', { status: 'failed', completed: 0, failed: 1 }],
    ])(
        'closes the progress with a %s terminal and skips the commit',
        async (status, terminalKind, expected) => {
            const recorder = makeNotifyRecorder();
            const metadata = { summaryception: makeSummaryStore() };
            installSummaryContext({ chat: buildChat(), metadata });
            callSummarizer.mockResolvedValue({ status });

            await expect(runOnePassage(recorder)).resolves.toEqual(expected);

            const progress = progressEvents(recorder);
            expect(progress).toHaveLength(1);
            expect(progress[0].label).toBe('batch-memory');
            expect(recorder.events.filter((event) => event.type === 'update')).toHaveLength(0);
            const clears = clearEvents(recorder);
            expect(clears).toHaveLength(1);
            expect(clears[0].handle).toBe(progress[0].handle);
            expect(clears[0].event).toEqual({ kind: terminalKind });
            expect(metadata.summaryception.layers[0]).toEqual([]);
            expect(metadata.summaryception.mutationEpoch).toBe(0);
        },
    );

    it('reports blocked and leaves the progress open until the queued commit flushes', async () => {
        const recorder = makeNotifyRecorder();
        const chat = buildChat();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );
        beginForegroundGeneration();

        await expect(runOnePassage(recorder)).resolves.toEqual({ status: 'blocked', completed: 1 });

        expect(progressEvents(recorder)).toHaveLength(1);
        expect(clearEvents(recorder)).toHaveLength(0);
        expect(metadata.summaryception.layers[0]).toEqual([]);

        await endForegroundGeneration();

        const clears = clearEvents(recorder);
        expect(clears).toHaveLength(1);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-updated' });
        expect(metadata.summaryception.layers[0]).toHaveLength(1);
    });

    it('emits no progress events when the Passage has no text', async () => {
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

        await expect(runOnePassage(recorder)).resolves.toEqual({ status: 'idle' });

        expect(callSummarizer).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([]);
    });

    it('reports idle without dispatching when the plan has no turn left to cover', async () => {
        const chat = buildChat();
        const metadata = {
            summaryception: makeSummaryStore({
                layers: [[{ text: VALID_SUMMARY, sourceMessageIds: ['assistant-id'] }]],
            }),
        };
        installSummaryContext({ chat, metadata });

        await expect(runLayer0(onePassagePlan(), makeNotifyRecorder())).resolves.toEqual({
            status: 'idle',
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('assigns missing IDs on the live chat before capturing the source Passage', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('assistant-id');
        const chat = buildChat();
        delete chat[1].sc_id;
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );

        await expect(runOnePassage()).resolves.toEqual({
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
        callSummarizer.mockImplementation(({ metadata: callMetadata }) => {
            dispatchMetadata = callMetadata;
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

        const resultPromise = runOnePassage();
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

    it('reports failed and restores chat and Layer 0 when post-mutation persistence fails', async () => {
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
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );

        await expect(runOnePassage()).resolves.toEqual({ status: 'failed' });

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });

    it('fails the run and skips the commit when the profile guard rejects a headerless summary', async () => {
        const chat = buildChat();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) => ({
            status: 'completed',
            text: 'A headerless summary paragraph.',
            profile: resolveCallProfile(makeSummarySettings(), dispatchMetadata),
        }));

        await expect(runOnePassage(makeNotifyRecorder())).resolves.toEqual({
            status: 'failed',
            completed: 0,
            failed: 1,
        });

        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});

describe('Layer 0 run — atomic Passages', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        resetCommitStateForTests();
    });

    function buildAtomicChat() {
        return [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: 'assistant-id-2', mes: 'Second assistant scene.' }),
        ];
    }

    const twoPartitions = [partition(1, 1), partition(3, 3)];

    it('closes the shared progress exactly once when a later Passage aborts', async () => {
        const recorder = makeNotifyRecorder();
        installSummaryContext({
            chat: buildAtomicChat(),
            metadata: { summaryception: makeSummaryStore() },
        });
        callSummarizer
            .mockImplementationOnce(async ({ metadata: dispatchMetadata }) =>
                completedOutcome(dispatchMetadata),
            )
            .mockImplementationOnce(async () => ({ status: 'aborted' }));

        await expect(runLayer0(atomicPlan(twoPartitions), recorder)).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        const progress = progressEvents(recorder);
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(2);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = clearEvents(recorder);
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it('discards the transaction when a later Passage has no text', async () => {
        const recorder = makeNotifyRecorder();
        const metadata = { summaryception: makeSummaryStore() };
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: '' }),
            makeMessage({ scId: 'assistant-id-2', mes: '' }),
        ];
        installSummaryContext({ chat, metadata });
        callSummarizer.mockImplementationOnce(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );

        await expect(runLayer0(atomicPlan(twoPartitions), recorder)).resolves.toEqual({
            status: 'failed',
            completed: 1,
            failed: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(clearEvents(recorder)).toHaveLength(1);
    });

    it('settles the shared progress and reports failed when a later Passage cannot capture its snapshot', async () => {
        const recorder = makeNotifyRecorder();
        installSummaryContext({
            chat: buildAtomicChat(),
            metadata: { summaryception: makeSummaryStore() },
        });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );
        // The second source range outruns the chat, the state a chat edit mid-run
        // leaves behind.
        const partitions = [partition(1, 1), partition(3, 9)];

        await expect(runLayer0(atomicPlan(partitions), recorder)).resolves.toEqual({
            status: 'failed',
        });

        const progress = progressEvents(recorder);
        expect(progress).toHaveLength(1);
        const clears = clearEvents(recorder);
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-failed' });
    });

    it('aborts remaining Passages when the store mutates mid-run', async () => {
        const recorder = makeNotifyRecorder();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat: buildAtomicChat(), metadata });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) => {
            metadata.summaryception.mutationEpoch += 1;
            return completedOutcome(dispatchMetadata);
        });

        await expect(runLayer0(atomicPlan(twoPartitions), recorder)).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(clearEvents(recorder)).toHaveLength(1);
        expect(clearEvents(recorder)[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it('aborts remaining Passages when the chat switches mid-run', async () => {
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat: buildAtomicChat(), metadata });
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) => {
            installSummaryContext({
                chat: [makeMessage({ scId: 'other-chat', mes: 'Other chat.' })],
                metadata,
            });
            return completedOutcome(dispatchMetadata);
        });

        await expect(runLayer0(atomicPlan(twoPartitions), makeNotifyRecorder())).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('reports failed and restores chat and Layer 0 when atomic post-mutation persistence fails', async () => {
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
        callSummarizer.mockImplementation(async ({ metadata: dispatchMetadata }) =>
            completedOutcome(dispatchMetadata),
        );

        await expect(runLayer0(atomicPlan([partition(1, 1)]), undefined)).resolves.toEqual({
            status: 'failed',
        });

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});
