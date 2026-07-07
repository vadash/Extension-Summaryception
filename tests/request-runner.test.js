import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installBrowserRuntimeStub } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
    processSummarizerResponse: vi.fn(),
    resolveFallback: vi.fn(),
    resolvePrimary: vi.fn(),
}));

vi.mock('../src/core/connectionutil.js', () => ({
    ConnectionError: class ConnectionError extends Error {
        constructor(message, opts = {}) {
            super(message);
            this.name = 'ConnectionError';
            this.retryable = opts.retryable;
        }
    },
    resolveSummarizerConnectionSettings: mocks.resolvePrimary,
    resolveFallbackSummarizerConnectionSettings: mocks.resolveFallback,
    sendSummarizerRequest: mocks.sendSummarizerRequest,
}));

vi.mock('../src/core/summarizer-pipeline.js', () => ({
    processSummarizerResponse: mocks.processSummarizerResponse,
    recordSuccessfulSummarizerUsage: vi.fn(),
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installBrowserRuntimeStub();
    mocks.resolvePrimary.mockReturnValue({ connectionSource: 'default' });
    mocks.processSummarizerResponse.mockReturnValue({
        status: 'success',
        text: 'summary',
        error: null,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('hard network failure fast-failover', () => {
    it('does not retry on "failed to fetch" and moves to fallback', async () => {
        mocks.sendSummarizerRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        mocks.resolveFallback.mockReturnValue({ connectionSource: 'fallback' });

        const { RequestRunner } = await import('../src/core/request-runner.js');
        const runner = new RequestRunner();

        const result = await runner.run({
            settings: { connectionSource: 'default' },
            systemPrompt: 'sys',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
        });

        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        expect(result).toBe('summary');
    });

    it('does not retry on "ECONNREFUSED" and moves to fallback', async () => {
        mocks.sendSummarizerRequest.mockRejectedValueOnce(
            new Error('ECONNREFUSED: connection refused'),
        );
        mocks.resolveFallback.mockReturnValue({ connectionSource: 'fallback' });

        const { RequestRunner } = await import('../src/core/request-runner.js');
        const runner = new RequestRunner();

        const result = await runner.run({
            settings: { connectionSource: 'default' },
            systemPrompt: 'sys',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'promotion' },
        });

        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        expect(result).toBe('summary');
    });

    it('still retries transient server errors', async () => {
        vi.useFakeTimers();
        const serverError = new Error('Server Error: 502');
        serverError.status = 502;
        mocks.sendSummarizerRequest
            .mockRejectedValueOnce(serverError)
            .mockRejectedValueOnce(serverError)
            .mockResolvedValueOnce('retry success');
        mocks.processSummarizerResponse.mockImplementation((raw) => ({
            status: 'success',
            text: raw,
            error: null,
        }));
        mocks.resolveFallback.mockReturnValue(null);

        const { RequestRunner } = await import('../src/core/request-runner.js');
        const runner = new RequestRunner();

        const resultPromise = runner.run({
            settings: { connectionSource: 'default' },
            systemPrompt: 'sys',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe('retry success');
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(3);
    });

    it('waits before restarting primary when fallback also hard-fails', async () => {
        vi.useFakeTimers();
        mocks.sendSummarizerRequest
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED: fallback refused'))
            .mockResolvedValueOnce('primary success');
        mocks.processSummarizerResponse.mockImplementation((raw) => ({
            status: 'success',
            text: raw,
            error: null,
        }));
        mocks.resolveFallback.mockReturnValue({ connectionSource: 'fallback' });

        const { RequestRunner } = await import('../src/core/request-runner.js');
        const runner = new RequestRunner();

        const resultPromise = runner.run({
            settings: { connectionSource: 'default' },
            systemPrompt: 'sys',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
        });
        await vi.runAllTimersAsync();

        await expect(resultPromise).resolves.toBe('primary success');
        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(3);
        expect(mocks.sendSummarizerRequest.mock.calls[1][4]).toMatchObject({ useFallback: true });
        expect(mocks.sendSummarizerRequest.mock.calls[2][4]).not.toHaveProperty('useFallback');
    });

    it('returns empty when hard failure occurs with no fallback configured', async () => {
        mocks.sendSummarizerRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        mocks.resolveFallback.mockReturnValue(null);

        const { RequestRunner } = await import('../src/core/request-runner.js');
        const runner = new RequestRunner();

        const result = await runner.run({
            settings: { connectionSource: 'default' },
            systemPrompt: 'sys',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
        });

        expect(mocks.sendSummarizerRequest).toHaveBeenCalledTimes(1);
        expect(result).toBe('');
    });
});
