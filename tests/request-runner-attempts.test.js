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
import { countSentences } from '../src/core/repair-diagnostics.js';
import { RequestRunner } from '../src/core/request-runner.js';
import { computeSentenceCap } from '../src/core/token-budget.js';
import { makeNotifyRecorder, makeSummarySettings, makeUsageLedger } from './test-helpers.js';

const usageLedger = await makeUsageLedger();

/** Minimal valid summary passage accepted by the real Output Hygiene chain. */
const VALID_SUMMARY =
    '<narrative>\nA concise summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * Hop-level behavior driven through the one call walk. Only the provider call
 * is mocked, so every verdict below is the real Output Hygiene, retry policy,
 * and walk at work. Single-route settings keep each scenario on one hop.
 */
describe('RequestRunner.run attempt walk', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    function makeRequest({ settings, profile, notify, signal, ...overrides } = {}) {
        const resolvedSettings = settings ?? makeSummarySettings();
        return {
            prompt: 'prompt',
            repairPrompt: 'repair',
            recall: 'recall',
            repairRecall: 'repair recall',
            signal: signal ?? new AbortController().signal,
            profile: profile ?? resolveCallProfile(resolvedSettings, { kind: 'layer0' }),
            notify: notify ?? makeNotifyRecorder(),
            usage: usageLedger,
            ...overrides,
            settings: resolvedSettings,
        };
    }

    function runRequest(overrides) {
        const request = makeRequest(overrides);
        return { request, outcome: new RequestRunner().run(request) };
    }

    it('completes with the text of the first accepted attempt', async () => {
        connectionMocks.sendSummarizerRequest.mockResolvedValue(VALID_SUMMARY);

        const { request, outcome } = runRequest();
        const result = await outcome;

        expect(result.status).toBe('completed');
        expect(result.text).toBe(VALID_SUMMARY);
        expect(result.profile).toBe(request.profile);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        const call = connectionMocks.sendSummarizerRequest.mock.calls[0][0];
        expect(call.userPrompt).toBe('prompt');
        // The recall message closes the request, after the payload.
        expect(call.recall).toBe('recall');
        // The system prompt comes from the frozen Call Profile, not the params.
        expect(call.systemPrompt).toBe(request.profile.policy.systemPrompt);
        expect(call.settings).toBe(request.settings);
    });

    it('switches to the repair prompt after a rejected output and completes', async () => {
        vi.useFakeTimers();
        connectionMocks.sendSummarizerRequest
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(VALID_SUMMARY);

        const { outcome } = runRequest();
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result.status).toBe('completed');
        expect(result.text).toBe(VALID_SUMMARY);
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
        const repairCall = connectionMocks.sendSummarizerRequest.mock.calls[1][0];
        // The retry consumed the repair payload and its own recall message.
        expect(repairCall.userPrompt).toBe('repair');
        expect(repairCall.recall).toBe('repair recall');
    });

    it('lands the attempt feedback inside the recall block, above its limits', async () => {
        vi.useFakeTimers();
        const repairRecall =
            '<recall>\nretry tasks\nlimits:\n<narrative>: write at most 3 sentences.\n</recall>\nNow write it.';
        connectionMocks.sendSummarizerRequest
            .mockResolvedValueOnce('location: dock')
            .mockResolvedValueOnce(VALID_SUMMARY);

        const { outcome } = runRequest({ repairRecall });
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result.status).toBe('completed');
        const repairCall = connectionMocks.sendSummarizerRequest.mock.calls[1][0];
        // An integrity rejection teaches the output contract, so the recall
        // block carries the feedback above its limits and keeps its trigger final.
        expect(repairCall.recall).toContain('<narrative>');
        expect(repairCall.recall).toContain('current_date_time:');
        expect(repairCall.recall).toContain('limits:');
        expect(repairCall.recall.endsWith('Now write it.')).toBe(true);
    });

    it('tightens the L0 sentence cap on the retry above limits with the trigger last', async () => {
        vi.useFakeTimers();
        const repairRecall =
            '<recall>\nretry tasks\nlimits:\n<narrative>: write at most 10 sentences.\n</recall>\nNow write it.';
        // Twelve rejected sentences against the default profile cap of 10:
        // the retry writes at most 9 and cuts at least 3.
        const rejectedDraft = Array.from(
            { length: 12 },
            (_v, i) => `Beat ${i} holds the line.`,
        ).join(' ');
        connectionMocks.sendSummarizerRequest
            .mockResolvedValueOnce(rejectedDraft)
            .mockResolvedValueOnce(VALID_SUMMARY);

        const { request, outcome } = runRequest({ repairRecall });
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result.status).toBe('completed');
        const calls = connectionMocks.sendSummarizerRequest.mock.calls;
        expect(calls).toHaveLength(2);
        // First attempt recall stays byte-identical: no tightening without a rejection.
        expect(calls[0][0].recall).toBe('recall');
        const retryRecall = String(calls[1][0].recall);
        const expectedCap = computeSentenceCap('l0', request.profile.policy.sizeGuard.target);
        const retryCap = Math.max(5, expectedCap - 1);
        const rejectedCount = countSentences(rejectedDraft);
        const expectedCut = Math.max(1, rejectedCount - retryCap);
        const tightening = `tighten: attempt 1, prior caps superseded, write at most ${retryCap} sentences; ${rejectedCount}-sentence draft -> ${retryCap}-sentence rewrite, cut at least ${expectedCut} weakest beats whole, survivor wording kept.`;
        expect(retryRecall).toContain(tightening);
        expect(retryRecall.indexOf('tighten:')).toBeLessThan(retryRecall.indexOf('limits:'));
        expect(retryRecall.endsWith('Now write it.')).toBe(true);
    });

    it('blocks with the guard event when the Easy context guard rejects the prompt', async () => {
        const recorder = makeNotifyRecorder();

        const { outcome } = runRequest({
            settings: makeSummarySettings({ uiMode: UI_MODES.EASY, advancedModelContext: 10 }),
            notify: recorder,
            prompt: 'x'.repeat(4000),
        });
        const result = await outcome;

        expect(result).toEqual({ status: 'blocked' });
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0].kind).toBe(NOTIFY_EVENTS.EASY_GUARD_BLOCKED);
        expect(recorder.events[0].limit).toBe(10);
    });

    it('returns aborted without sending when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const recorder = makeNotifyRecorder();

        const { outcome } = runRequest({ signal: controller.signal, notify: recorder });
        const result = await outcome;

        expect(result).toEqual({ status: 'aborted' });
        expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([{ type: 'transient', kind: 'run-aborted' }]);
    });

    it('returns aborted when the request reports a user abort', async () => {
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('Aborted by user'));

        const { outcome } = runRequest();
        const result = await outcome;

        expect(result).toEqual({ status: 'aborted' });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
    });

    it('fails after one attempt on a hard failover and skips the remaining retries', async () => {
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('Failed to fetch'));

        const { outcome } = runRequest({ notify: recorder });
        const result = await outcome;

        expect(result).toEqual({ status: 'failed', attempts: 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        expect(recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT)).toHaveLength(0);
        expect(recorder.events[recorder.events.length - 1]).toEqual({
            type: 'transient',
            kind: NOTIFY_EVENTS.RUN_FAILED,
            retriesExhausted: false,
            attempts: 1,
            status: null,
        });
    });

    it('exhausts the retry budget on retryable failures and reports failed', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));

        const { outcome } = runRequest({ notify: recorder });
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
        const retryWaits = recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT);
        expect(retryWaits.map((e) => e.attempt)).toEqual([0, 1, 2]);
        expect(recorder.events[recorder.events.length - 1]).toEqual({
            type: 'transient',
            kind: NOTIFY_EVENTS.RUN_FAILED,
            retriesExhausted: true,
            attempts: RETRY_CONFIG.maxRetries + 1,
            status: null,
        });
    });

    it('fails after one attempt on a non-retryable error', async () => {
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));

        const { outcome } = runRequest({ notify: recorder });
        const result = await outcome;

        expect(result).toEqual({ status: 'failed', attempts: 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.RUN_FAILED,
                retriesExhausted: false,
                attempts: 1,
                status: null,
            },
        ]);
    });

    it('never completes on output that fails integrity, so completed means accepted', async () => {
        vi.useFakeTimers();
        connectionMocks.sendSummarizerRequest.mockResolvedValue('location: dock');

        const { outcome } = runRequest({ repairPrompt: '' });
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result.status).toBe('failed');
        expect(result).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
    });

    it('exhausts the retry budget on rejected outputs', async () => {
        vi.useFakeTimers();
        const recorder = makeNotifyRecorder();
        connectionMocks.sendSummarizerRequest.mockResolvedValue('');

        const { outcome } = runRequest({ repairPrompt: '', notify: recorder });
        await vi.runAllTimersAsync();
        const result = await outcome;

        expect(result).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
            RETRY_CONFIG.maxRetries + 1,
        );
        expect(recorder.events[recorder.events.length - 1]).toMatchObject({
            kind: NOTIFY_EVENTS.RUN_FAILED,
            retriesExhausted: true,
            attempts: RETRY_CONFIG.maxRetries + 1,
        });
    });
});
