import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { isCancellableConnection } from '../src/core/connectionutil.js';
import { createAttemptSession } from '../src/core/request-series.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { makeNotifyRecorder, makeSummarySettings } from './test-helpers.js';

describe('route series timeout retryability vs cancellation capability', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeSession({ settings: settingsOverride, ...overrides } = {}) {
        const settings = settingsOverride ?? makeSummarySettings();
        const session = createAttemptSession({
            prompt: 'prompt',
            repairPrompt: '',
            signal: new AbortController().signal,
            profile: resolveCallProfile(settings, { kind: 'layer0' }),
            notify: makeNotifyRecorder(),
            ...overrides,
        });
        return {
            session,
            route: { connection: settings, timeoutMs: 10 },
            hop: { routeLabel: 'primary', maxRetries: 3 },
        };
    }

    it('exposes the cancellation capability per registered provider', () => {
        expect(
            isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'default' }),
        ).toBe(false);
        expect(
            isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'profile' }),
        ).toBe(true);
    });

    /**
     * The request mock never resolves, so every attempt hangs until its
     * timeout fires; the series classifies each timeout the same way.
     */
    async function runHungSeries(overrides) {
        connectionMocks.sendSummarizerRequest.mockReturnValue(new Promise(() => {}));
        const { session, route, hop } = makeSession(overrides);
        const pending = session.runSeries(route, hop);
        await vi.runAllTimersAsync();
        return await pending;
    }

    it('marks the timeout non-retryable on the uncancellable default route', async () => {
        vi.useFakeTimers();
        const result = await runHungSeries({
            settings: makeSummarySettings({ connectionSource: 'default' }),
        });

        expect(result.status).toBe('failed');
        expect(result.retryable).toBe(false);
        expect(result.attempts).toBe(1);
        expect(result.error.name).toBe('ConnectionError');
        expect(result.error.message).toContain('timed out');
    });

    it('keeps the timeout retryable on the cancellable profile route', async () => {
        vi.useFakeTimers();
        const result = await runHungSeries({
            settings: makeSummarySettings({ connectionSource: 'profile' }),
        });

        expect(result.status).toBe('failed');
        expect(result.retryable).toBe(true);
        expect(result.attempts).toBe(RETRY_CONFIG.maxRetries + 1);
    });
});
