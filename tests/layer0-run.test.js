import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { runLayer0 } from '../src/core/layer0-run.js';
import { UI_MODES } from '../src/foundation/constants.js';
import { SUMMARY_COMMIT_MODES } from '../src/core/summarization-routes.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeNotifyRecorder,
    makeSummarizerDispatch,
    makeSummaryStore,
} from './test-helpers.js';

/** @type {import('../src/core/foreground-gate.js').ForegroundGate} */
let gate;

beforeEach(() => {
    gate = makeForegroundGate().gate;
});

/** Minimal valid provider output accepted by the real Output Hygiene chain. */
const VALID_SUMMARY =
    '<narrative>\nA concise summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * Build the real Summarizer Dispatch after the context is installed, wrapped so
 * the layer's dispatch arguments stay observable. The real walk resolves the
 * Call Profile from the installed context settings.
 */
async function makeDispatch() {
    const dispatch = await makeSummarizerDispatch();
    return vi.fn((request) => dispatch.call(request));
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
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function runOnePassage(dispatch, recorder) {
        return runLayer0(onePassagePlan(), { notify: recorder, gate, dispatch });
    }

    it('commits one Passage and reports completed', async () => {
        const recorder = makeNotifyRecorder();
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat: buildChat(), metadata });
        let progressOpenAtRequest = false;
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            progressOpenAtRequest = recorder.events.some((event) => event.type === 'progress');
            return VALID_SUMMARY;
        });
        const dispatch = await makeDispatch();

        await expect(runOnePassage(dispatch, recorder)).resolves.toEqual({
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
        {
            status: 'aborted',
            terminalKind: 'batch-memory-aborted',
            expected: { status: 'aborted', completed: 0 },
            arrange: () =>
                connectionMocks.sendSummarizerRequest.mockRejectedValue(
                    new Error('Aborted by user'),
                ),
        },
        {
            status: 'blocked',
            terminalKind: 'batch-memory-failed',
            expected: { status: 'failed', completed: 0, failed: 1 },
            // Settings normalization clamps the Easy cap to 8000, so the story
            // must exceed the cap for the guard to block the request.
            settings: { uiMode: UI_MODES.EASY, advancedModelContext: 8000 },
            chat: [
                makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
                makeMessage({ scId: 'assistant-id', mes: 'x'.repeat(9000) }),
            ],
        },
        {
            status: 'failed',
            terminalKind: 'batch-memory-failed',
            expected: { status: 'failed', completed: 0, failed: 1 },
            arrange: () =>
                connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request')),
        },
    ])(
        'closes the progress with a $status terminal and skips the commit',
        async ({ terminalKind, expected, arrange, settings, chat = buildChat() }) => {
            const recorder = makeNotifyRecorder();
            const metadata = { summaryception: makeSummaryStore() };
            installSummaryContext({ chat, metadata, settings });
            arrange?.();
            const dispatch = await makeDispatch();

            await expect(runOnePassage(dispatch, recorder)).resolves.toEqual(expected);

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
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();
        gate.beginGeneration();

        await expect(runOnePassage(dispatch, recorder)).resolves.toEqual({
            status: 'blocked',
            completed: 1,
        });

        expect(progressEvents(recorder)).toHaveLength(1);
        expect(clearEvents(recorder)).toHaveLength(0);
        expect(metadata.summaryception.layers[0]).toEqual([]);

        await gate.endGeneration();

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
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();

        await expect(runOnePassage(dispatch, recorder)).resolves.toEqual({ status: 'idle' });

        expect(dispatch).not.toHaveBeenCalled();
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
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(onePassagePlan(), { notify: makeNotifyRecorder(), gate, dispatch }),
        ).resolves.toEqual({
            status: 'idle',
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('assigns missing IDs on the live chat before capturing the source Passage', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('assistant-id');
        const chat = buildChat();
        delete chat[1].sc_id;
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();

        await expect(runOnePassage(dispatch)).resolves.toEqual({
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
        connectionMocks.sendSummarizerRequest.mockImplementation(
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
        const dispatch = await makeDispatch();

        const resultPromise = runOnePassage(dispatch);
        await vi.waitFor(() => expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalled());

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(saveChat).not.toHaveBeenCalled();
        resolveSummary(VALID_SUMMARY);
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
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();

        await expect(runOnePassage(dispatch)).resolves.toEqual({ status: 'failed' });

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});

describe('Layer 0 run — atomic Passages', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
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
        connectionMocks.sendSummarizerRequest
            .mockResolvedValueOnce(VALID_SUMMARY)
            .mockRejectedValueOnce(new Error('Aborted by user'));
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(atomicPlan(twoPartitions), { notify: recorder, gate, dispatch }),
        ).resolves.toEqual({
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
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(atomicPlan(twoPartitions), { notify: recorder, gate, dispatch }),
        ).resolves.toEqual({
            status: 'failed',
            completed: 1,
            failed: 1,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(clearEvents(recorder)).toHaveLength(1);
    });

    it('settles the shared progress and reports failed when a later Passage cannot capture its snapshot', async () => {
        const recorder = makeNotifyRecorder();
        installSummaryContext({
            chat: buildAtomicChat(),
            metadata: { summaryception: makeSummaryStore() },
        });
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();
        // The second source range outruns the chat, the state a chat edit mid-run
        // leaves behind.
        const partitions = [partition(1, 1), partition(3, 9)];

        await expect(
            runLayer0(atomicPlan(partitions), { notify: recorder, gate, dispatch }),
        ).resolves.toEqual({
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
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            metadata.summaryception.mutationEpoch += 1;
            return VALID_SUMMARY;
        });
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(atomicPlan(twoPartitions), { notify: recorder, gate, dispatch }),
        ).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(clearEvents(recorder)).toHaveLength(1);
        expect(clearEvents(recorder)[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it('aborts remaining Passages when the chat switches mid-run', async () => {
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat: buildAtomicChat(), metadata });
        connectionMocks.sendSummarizerRequest.mockImplementation(async () => {
            installSummaryContext({
                chat: [makeMessage({ scId: 'other-chat', mes: 'Other chat.' })],
                metadata,
            });
            return VALID_SUMMARY;
        });
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(atomicPlan(twoPartitions), { notify: makeNotifyRecorder(), gate, dispatch }),
        ).resolves.toEqual({
            status: 'aborted',
            completed: 1,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
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
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);
        const dispatch = await makeDispatch();

        await expect(
            runLayer0(atomicPlan([partition(1, 1)]), { notify: undefined, gate, dispatch }),
        ).resolves.toEqual({
            status: 'failed',
        });

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});
