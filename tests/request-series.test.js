import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { NOTIFY_EVENTS, UI_MODES } from '../src/foundation/constants.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { runRouteSeries } from '../src/core/request-series.js';
import { makeNotifyRecorder, makeSummarySettings } from './test-helpers.js';

/** Minimal valid summary passage accepted by the real Output Hygiene chain. */
const VALID_SUMMARY =
    '<narrative>\nA concise summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * The Route Series is one Narrative Chain hop: repeated attempts over one
 * connection route until the attempt settles terminally or the retry budget
 * runs out. Tests drive the series interface; only the provider call is
 * mocked, so every status below is the real Output Hygiene and retry policy
 * at work.
 */
describe('runRouteSeries outcomes', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeSeriesParams({ settings, profile, ...overrides } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: new AbortController().signal,
            profile: profile ?? resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            route: { connection: resolvedSettings, timeoutMs: 30000 },
            routeLabel: 'primary',
            maxRetries: RETRY_CONFIG.maxRetries,
            notify: makeNotifyRecorder(),
            ...overrides,
        };
    }

    it('completes with the text of the first accepted attempt', async () => {
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);

        const params = makeSeriesParams();
        const result = await runRouteSeries(params);

        expect(result.status).toBe('completed');
        expect(result.text).toBe(VALID_SUMMARY);
        expect(result.attempts).toBe(1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        const call = connectionMocks.sendSummarizerRequest.mock.calls[0][0];
        expect(call.userPrompt).toBe('prompt');
        // The system prompt comes from the frozen Call Profile, not the params.
        expect(call.systemPrompt).toBe(params.profile.policy.systemPrompt);
        expect(call.settings).toBe(params.route.connection);
    });

    it('switches to the repair prompt after a rejected output and completes', async () => {
        vi.useFakeTimers();
        connectionMocks.sendSummarizerRequest
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(VALID_SUMMARY);

        const pending = runRouteSeries(makeSeriesParams());
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.status).toBe('completed');
        expect(result.attempts).toBe(2);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        const repairCall = connectionMocks.sendSummarizerRequest.mock.calls[1][0];
        // The retry consumed the repair prompt, not the original user prompt.
        expect(repairCall.userPrompt.startsWith('repair')).toBe(true);
    });

    it('stops with guard-stopped when the Easy context guard rejects the prompt', async () => {
        const recorder = makeNotifyRecorder();
        const result = await runRouteSeries(
            makeSeriesParams({
                settings: makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 }),
                notify: recorder,
                prompt: 'x'.repeat(4000),
            }),
        );

        expect(result.status).toBe('guard-stopped');
        expect(result.attempts).toBe(1);
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0].kind).toBe(NOTIFY_EVENTS.EASY_GUARD_BLOCKED);
        expect(recorder.events[0].limit).toBe(10);
    });

    it('returns aborted without sending when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runRouteSeries(makeSeriesParams({ signal: controller.signal }));

        expect(result.status).toBe('aborted');
        expect(result.attempts).toBe(0);
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
    });

    it('returns aborted when the request reports a user abort', async () => {
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('Aborted by user'));

        const result = await runRouteSeries(makeSeriesParams());

        expect(result.status).toBe('aborted');
        expect(result.attempts).toBe(1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
    });

    it('reports hard failover once and skips the remaining retries', async () => {
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('Failed to fetch'));

        const result = await runRouteSeries(makeSeriesParams());

        expect(result.status).toBe('hard-failover');
        expect(result.attempts).toBe(1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
    });

    it('exhausts the retry budget on retryable failures and reports failed as retryable', async () => {
        vi.useFakeTimers();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));

        const pending = runRouteSeries(makeSeriesParams());
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.status).toBe('failed');
        expect(result.retryable).toBe(true);
        expect(result.attempts).toBe(RETRY_CONFIG.maxRetries + 1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
    });

    it('reports a non-retryable failure after one attempt', async () => {
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));

        const result = await runRouteSeries(makeSeriesParams());

        expect(result.status).toBe('failed');
        expect(result.retryable).toBe(false);
        expect(result.attempts).toBe(1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
    });

    it('exhausts the retry budget on rejected outputs and reports the rejection reason', async () => {
        vi.useFakeTimers();
        connectionMocks.sendSummarizerRequest.mockResolvedValue('');

        const pending = runRouteSeries(makeSeriesParams({ repairPrompt: '' }));
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe('empty');
        expect(result.error).toBeInstanceOf(Error);
        expect(result.attempts).toBe(RETRY_CONFIG.maxRetries + 1);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
    });
});
