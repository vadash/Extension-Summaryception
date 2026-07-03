import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    summarizeBatchFromTurns: vi.fn(),
    summarizeOneBatchFromTurns: vi.fn(),
    maybePromoteLayer: vi.fn(),
}));

vi.mock('../src/core/summarizer-batch.js', () => ({
    summarizeBatchFromTurns: mocks.summarizeBatchFromTurns,
    summarizeOneBatchFromTurns: mocks.summarizeOneBatchFromTurns,
}));

vi.mock('../src/core/summarizer-promotion.js', () => ({
    maybePromoteLayer: mocks.maybePromoteLayer,
}));

function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.toastr = {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
    globalThis.$ = () => ({ find: () => ({ text: vi.fn() }) });
});

describe('requestSummarization', () => {
    it('coalesces message events that arrive while a batch request is in flight', async () => {
        const firstBatch = deferred();
        mocks.summarizeBatchFromTurns
            .mockImplementationOnce(async () => {
                await firstBatch.promise;
                return true;
            })
            .mockResolvedValueOnce(true);

        installSillyTavernStub({
            chat: [
                makeMessage({ mes: 'first' }),
                makeMessage({ mes: 'second' }),
                makeMessage({ mes: 'third' }),
            ],
            settings: {
                enabled: true,
                pauseSummarization: false,
                verbatimTurns: 1,
                turnsPerSummary: 1,
            },
        });

        const { requestSummarization } = await import('../src/core/summarizer.js');
        const firstRun = requestSummarization({ reason: 'first-message', mode: 'auto' });

        await Promise.resolve();
        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1);

        const secondRun = requestSummarization({ reason: 'second-message', mode: 'auto' });
        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(1);

        firstBatch.resolve();
        await firstRun;
        await secondRun;

        expect(mocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(2);
    });
});

describe('foreground commit guard', () => {
    it('queues completed background commits until foreground generation ends', async () => {
        const {
            beginForegroundGeneration,
            commitWhenSafe,
            endForegroundGeneration,
            getPendingCommitCount,
            resetCommitStateForTests,
            setCommitCallbacks,
        } = await import('../src/core/summarizer-commit.js');

        resetCommitStateForTests();
        const reassertInjection = vi.fn();
        const setExtensionPrompt = vi.fn();
        const hideMessages = vi.fn();

        setCommitCallbacks({
            reassertInjection,
        });

        beginForegroundGeneration();
        const result = await commitWhenSafe({
            kind: 'layer0',
            snapshot: {},
            apply: async () => {
                setExtensionPrompt();
                hideMessages();
                return true;
            },
        });

        expect(result).toBe('queued');
        expect(getPendingCommitCount()).toBe(1);
        expect(reassertInjection).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt).not.toHaveBeenCalled();
        expect(hideMessages).not.toHaveBeenCalled();

        await endForegroundGeneration();

        expect(getPendingCommitCount()).toBe(0);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(hideMessages).toHaveBeenCalledTimes(1);
    });
});
