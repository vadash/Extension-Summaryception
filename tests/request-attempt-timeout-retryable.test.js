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
import { resolveCallProfile } from '../src/core/call-profile.js';
import { isCancellableConnection } from '../src/core/connectionutil.js';
import { makeSummarySettings } from './test-helpers.js';

/**
 * On an uncancellable route, the host generateRaw call has no abort signal. A
 * timed-out request keeps running there, so the runner must not retry the
 * timeout. Cancellable routes cancel the request for real, so they may retry.
 */
describe('attempt timeout retryability vs cancellation capability', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const mock of Object.values(connectionMocks)) {
            mock.mockReset();
        }
    });

    function makeAttemptParams(overrides = {}) {
        const settings = overrides.settings ?? makeSummarySettings();
        return {
            settings,
            systemPrompt: 'system',
            prompt: 'prompt',
            signal: new AbortController().signal,
            profile: resolveCallProfile(settings, { kind: 'layer0' }),
            connection: settings,
            attempt: 0,
            maxRetries: 3,
            routeLabel: 'primary',
            timeoutMs: 10,
            ...overrides,
        };
    }

    /**
     * The request mock never resolves, which makes the attempt hang. The
     * runner classifies each failure the same way.
     */
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
