import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSummaryContext } from './test-helpers.js';

let contextMocks;
let loggerMocks;

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    installSummaryContext({ chat: [], settings: { enabled: false } });
    contextMocks = globalThis.summaryceptionFoundationMocks.context;
    loggerMocks = globalThis.summaryceptionFoundationMocks.logger;
    contextMocks.getStreamingProcessor.mockReturnValue(null);
    contextMocks.isSendButtonInStopMode.mockReturnValue(false);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('foreground commit guard recovery', () => {
    it('auto-heals a stale idle freeze and flushes queued commits', async () => {
        const {
            beginForegroundGeneration,
            commitWhenSafe,
            getPendingCommitCount,
            isPromptMutationFrozen,
            recoverStalePromptFreeze,
            resetCommitStateForTests,
        } = await import('../src/core/summarizer-commit.js');
        const apply = vi.fn(async () => true);

        resetCommitStateForTests();
        contextMocks.isSendButtonInStopMode.mockReturnValue(true);
        beginForegroundGeneration();

        await expect(
            commitWhenSafe({
                kind: 'layer0',
                snapshot: {},
                apply,
            }),
        ).resolves.toBe('queued');
        expect(getPendingCommitCount()).toBe(1);

        contextMocks.isSendButtonInStopMode.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(1000);

        await expect(recoverStalePromptFreeze('test heartbeat')).resolves.toBe(true);

        expect(isPromptMutationFrozen()).toBe(false);
        expect(getPendingCommitCount()).toBe(0);
        expect(apply).toHaveBeenCalledOnce();
        expect(loggerMocks.warn).toHaveBeenCalledWith(
            'Stale foreground freeze detected; auto-healing lock',
            'reason=test heartbeat',
        );
    });

    it('keeps the guard closed while the streaming processor is active', async () => {
        const {
            beginForegroundGeneration,
            isPromptMutationFrozen,
            recoverStalePromptFreeze,
            resetCommitStateForTests,
        } = await import('../src/core/summarizer-commit.js');

        resetCommitStateForTests();
        beginForegroundGeneration();
        contextMocks.getStreamingProcessor.mockReturnValue({ isFinished: false });
        await vi.advanceTimersByTimeAsync(1000);

        await expect(recoverStalePromptFreeze('stream heartbeat')).resolves.toBe(false);

        expect(isPromptMutationFrozen()).toBe(true);
    });

    it('applies a new commit after healing a stale guard instead of re-queueing it', async () => {
        const {
            beginForegroundGeneration,
            commitWhenSafe,
            getPendingCommitCount,
            resetCommitStateForTests,
        } = await import('../src/core/summarizer-commit.js');
        const apply = vi.fn(async () => true);

        resetCommitStateForTests();
        beginForegroundGeneration();
        await vi.advanceTimersByTimeAsync(1000);

        await expect(
            commitWhenSafe({
                kind: 'layer0',
                snapshot: {},
                apply,
            }),
        ).resolves.toBe('applied');

        expect(getPendingCommitCount()).toBe(0);
        expect(apply).toHaveBeenCalledOnce();
        expect(loggerMocks.warn).toHaveBeenCalledWith(
            'Stale foreground freeze detected; auto-healing lock',
            'reason=layer0 commit',
        );
    });
});
