import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});
// The global setup logger mock lacks serializeError, which classifyAttemptError uses.
vi.mock('../src/foundation/logger.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...globalThis.summaryceptionFoundationMocks.logger,
        serializeError: actual.serializeError,
    };
});

import { classifyAttemptError, runSingleAttempt } from '../src/core/request-attempt.js';
import { isCancellableConnection } from '../src/core/connectionutil.js';
import { makeSummarySettings } from './test-helpers.js';

/**
 * Attempt-timeout retryability follows the route's cancellation capability:
 * on an uncancellable route (host generateRaw has no abort signal) a timed-out
 * request is orphaned, so the timeout must not be retried; cancellable routes
 * genuinely cancel the request and may retry.
 */
describe('attempt timeout retryability vs cancellation capability', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const mock of Object.values(connectionMocks)) {
            mock.mockReset();
        }
    });

    function makeAttemptParams(overrides = {}) {
        return {
            settings: makeSummarySettings(),
            systemPrompt: 'system',
            prompt: 'prompt',
            signal: new AbortController().signal,
            metadata: { kind: 'layer0' },
            attempt: 0,
            maxRetries: 3,
            routeLabel: 'primary',
            timeoutMs: 10,
            ...overrides,
        };
    }

    /** Run one attempt whose request never resolves; classify like the runner does. */
    async function runHungAttempt(params) {
        connectionMocks.sendSummarizerRequest.mockReturnValue(new Promise(() => {}));
        let caught;
        try {
            await runSingleAttempt(params);
        } catch (err) {
            caught = err;
        }
        return { caught, result: classifyAttemptError(caught, params.signal) };
    }

    it('exposes the cancellation capability per registered provider', () => {
        expect(isCancellableConnection(makeSummarySettings({ connectionSource: 'default' }))).toBe(
            false,
        );
        expect(isCancellableConnection(makeSummarySettings({ connectionSource: 'profile' }))).toBe(
            true,
        );
        expect(isCancellableConnection(makeSummarySettings({ connectionSource: 'nope' }))).toBe(
            false,
        );
    });

    it('marks the attempt timeout non-retryable on the uncancellable default route', async () => {
        const { caught, result } = await runHungAttempt(
            makeAttemptParams({ settings: makeSummarySettings({ connectionSource: 'default' }) }),
        );

        expect(caught.name).toBe('ConnectionError');
        expect(caught.retryable).toBe(false);
        expect(result.shouldRetry).toBe(false);
    });

    it('keeps the attempt timeout retryable on the cancellable profile route', async () => {
        const { caught, result } = await runHungAttempt(
            makeAttemptParams({ settings: makeSummarySettings({ connectionSource: 'profile' }) }),
        );

        expect(caught.name).toBe('ConnectionError');
        expect(caught.retryable).toBe(true);
        expect(result.shouldRetry).toBe(true);
    });
});
