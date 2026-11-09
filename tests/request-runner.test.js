import { afterEach, describe, expect, it, vi } from 'vitest';

const connectionMocks = vi.hoisted(() => ({
    sendSummarizerRequest: vi.fn(),
}));
vi.mock('../src/core/connectionutil.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ...connectionMocks };
});

import { isCancellableConnection } from '../src/core/connectionutil.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { countSentences } from '../src/core/repair-diagnostics.js';
import { RequestRunner } from '../src/core/request-runner.js';
import { computeSentenceCap } from '../src/core/token-budget.js';
import { NOTIFY_EVENTS, UI_MODES } from '../src/foundation/constants.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
    makeUsageLedger,
} from './test-helpers.js';

const usageLedger = await makeUsageLedger();

/** Minimal valid summary passage accepted by the real Output Hygiene chain. */
const VALID_SUMMARY =
    '<narrative>\nA concise summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu';

/**
 * The one RequestRunner.run seam: only the provider call is mocked, so every
 * verdict below is the real Output Hygiene chain, retry policy, and call walk
 * at work. Outcomes and notify events are the runner's contract (ADR-0019);
 * retries consume the profile frozen at dispatch (ADR-0023).
 */
describe('RequestRunner.run', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        connectionMocks.sendSummarizerRequest.mockReset();
    });

    /** Shared transport rig: single-route settings keep each scenario on one hop. */
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

    describe('attempt walk', () => {
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
            const { toastr } = installBrowserRuntimeStub();
            const recorder = makeNotifyRecorder();
            const settings = makeSummarySettings({
                uiMode: UI_MODES.EASY,
                advancedModelContext: 10,
            });

            const { outcome } = runRequest({
                settings,
                notify: recorder,
                prompt: 'x'.repeat(4000),
            });
            const result = await outcome;

            expect(result).toEqual({ status: 'blocked' });
            expect(connectionMocks.sendSummarizerRequest).not.toHaveBeenCalled();
            // The attempt layer emits the structured guard event; the
            // guard-block branch adds no run-failed event on top.
            expect(toastr.error).not.toHaveBeenCalled();
            expect(recorder.events).toHaveLength(1);
            const event = recorder.events[0];
            expect(event.type).toBe('transient');
            expect(event.kind).toBe(NOTIFY_EVENTS.EASY_GUARD_BLOCKED);
            expect(event.tokens).toBeGreaterThan(10);
            expect(event.limit).toBe(10);
            expect(typeof event.estimated).toBe('boolean');
            expect(typeof event.label).toBe('string');
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
            expect(recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT)).toHaveLength(
                0,
            );
            expect(recorder.events[recorder.events.length - 1]).toEqual({
                type: 'transient',
                kind: NOTIFY_EVENTS.RUN_FAILED,
                retriesExhausted: false,
                attempts: 1,
                status: null,
            });
        });

        it('fails after one attempt on a non-retryable error without the guard', async () => {
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
            // Mid-run retries surface as structured retry-wait events (ADR-0019).
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

    describe('Run Outcome mapping', () => {
        it('retries consume the profile frozen at dispatch, not live settings', async () => {
            vi.useFakeTimers();
            const settings = makeSummarySettings({ layer0SummaryTokenTarget: 300 });
            const request = makeRequest({ settings });
            connectionMocks.sendSummarizerRequest.mockImplementationOnce(() => {
                // A mid-run settings edit must not reach an in-flight call's retries (ADR-0023).
                settings.uiMode = UI_MODES.EASY;
                settings.advancedModelContext = 10;
                settings.layer0SummaryTokenTarget = 999;
                return Promise.reject(new Error('timeout'));
            });
            connectionMocks.sendSummarizerRequest.mockResolvedValueOnce(VALID_SUMMARY);

            const pending = new RequestRunner().run(request);
            await vi.runAllTimersAsync();
            const outcome = await pending;

            expect(outcome.status).toBe('completed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
            expect(outcome.profile).toBe(request.profile);
            expect(outcome.profile.policy.easyContextLimit).toBeNull();
            expect(outcome.profile.policy.sizeGuard.target).toBe(300);
        });

        it('stops at the failing hop when the error is neither retryable nor a hard failover', async () => {
            const recorder = makeNotifyRecorder();
            connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('bad request'));
            const settings = makeSummarySettings({ fallbackConnectionSource: 'profile' });

            const { outcome } = runRequest({ settings, notify: recorder });
            const result = await outcome;

            expect(result.status).toBe('failed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(1);
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

        it('walks the inherited narrative chain for an inherit-sourced auditor on hard failover', async () => {
            connectionMocks.sendSummarizerRequest
                .mockRejectedValueOnce(new Error('Failed to fetch'))
                .mockResolvedValueOnce(VALID_SUMMARY);

            const settings = makeSummarySettings({
                auditorConnectionSource: 'inherit',
                requestTimeoutSeconds: 33,
                fallbackConnectionSource: 'profile',
                fallbackConnectionProfileId: 'backup',
                fallbackRequestTimeoutSeconds: 34,
            });
            const profile = resolveCallProfile(settings, { kind: 'auditor' });

            const { outcome } = runRequest({ settings, profile });
            const result = await outcome;

            expect(result.status).toBe('completed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
            const calls = connectionMocks.sendSummarizerRequest.mock.calls;
            expect(calls[0][0].settings).toBe(settings);
            expect(calls[1][0].settings.connectionProfileId).toBe('backup');
            // Route timeouts are resolved by the Call Profile, not read live.
            expect(profile.policy.routes.map((route) => route.timeoutMs)).toEqual([33000, 34000]);
        });

        it('runs a separated auditor as one hop with no failover', async () => {
            vi.useFakeTimers();
            connectionMocks.sendSummarizerRequest
                .mockRejectedValueOnce(new Error('timeout'))
                .mockResolvedValueOnce(VALID_SUMMARY);

            const settings = makeSummarySettings({
                auditorConnectionSource: 'profile',
                auditorConnectionProfileId: 'aud-1',
                auditorRequestTimeoutSeconds: 31,
                // Removed route keys stay in old stored settings; they are dead.
                auditorFallbackConnectionSource: 'profile',
                auditorFallbackConnectionProfileId: 'aud-2',
                auditorFallbackRequestTimeoutSeconds: 32,
                auditorNarrativeFallback: true,
            });
            const profile = resolveCallProfile(settings, { kind: 'auditor' });

            const { outcome: pending } = runRequest({ settings, profile });
            await vi.runAllTimersAsync();
            const outcome = await pending;

            expect(outcome.status).toBe('completed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
            const calls = connectionMocks.sendSummarizerRequest.mock.calls;
            expect(calls[0][0].settings.connectionProfileId).toBe('aud-1');
            expect(calls[1][0].settings.connectionProfileId).toBe('aud-1');
            // The single hop retries itself; there is no second connection to fail over to.
            expect(profile.policy.routes).toHaveLength(1);
            expect(profile.policy.routes.map((route) => route.timeoutMs)).toEqual([31000]);
        });

        it('probes the primary once after a prior call exhausted it and the fallback succeeded', async () => {
            vi.useFakeTimers();
            const settings = makeSummarySettings({
                fallbackConnectionSource: 'profile',
                fallbackConnectionProfileId: 'backup',
            });
            const runner = new RequestRunner();

            // First call: the primary uses its whole retry budget, then the fallback succeeds.
            connectionMocks.sendSummarizerRequest
                .mockRejectedValueOnce(new Error('timeout'))
                .mockRejectedValueOnce(new Error('timeout'))
                .mockRejectedValueOnce(new Error('timeout'))
                .mockRejectedValueOnce(new Error('timeout'))
                .mockResolvedValueOnce(VALID_SUMMARY);
            const firstPending = runner.run(makeRequest({ settings }));
            await vi.runAllTimersAsync();
            expect((await firstPending).status).toBe('completed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
                RETRY_CONFIG.maxRetries + 2,
            );

            // Second call: the exhausted health bucket grants the primary one probe
            // attempt, so a hard failover costs one call before the fallback.
            connectionMocks.sendSummarizerRequest
                .mockReset()
                .mockRejectedValueOnce(new Error('Failed to fetch'))
                .mockResolvedValueOnce(VALID_SUMMARY);
            const outcome = await runner.run(makeRequest({ settings }));

            expect(outcome.status).toBe('completed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(2);
            const calls = connectionMocks.sendSummarizerRequest.mock.calls;
            expect(calls[0][0].settings).toBe(settings);
            expect(calls[1][0].settings.connectionProfileId).toBe('backup');
        });
    });

    describe('notify events', () => {
        it('emits the retry event before waiting and abort cuts the wait short', async () => {
            const recorder = makeNotifyRecorder();
            const controller = new AbortController();
            connectionMocks.sendSummarizerRequest.mockRejectedValueOnce(
                Object.assign(new Error('rate limited'), { retryAfter: 60, status: 429 }),
            );

            const { outcome: pending } = runRequest({
                notify: recorder,
                signal: controller.signal,
            });
            // Park on the retry wait: the first attempt failed, the wait runs.
            await vi.waitFor(() => expect(recorder.events).toHaveLength(1));
            expect(recorder.events[0]).toEqual({
                type: 'transient',
                kind: NOTIFY_EVENTS.RETRY_WAIT,
                attempt: 0,
                delayMs: 60000,
                maxRetries: RETRY_CONFIG.maxRetries,
            });

            controller.abort();
            const outcome = await pending;

            expect(outcome).toEqual({ status: 'aborted' });
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
            // The walk re-checks the signal on the next attempt and renders the abort.
            expect(recorder.events.map((event) => event.kind)).toEqual([
                NOTIFY_EVENTS.RETRY_WAIT,
                NOTIFY_EVENTS.RUN_ABORTED,
            ]);
        });

        it('emits the route-cycle event and waits before retrying the primary', async () => {
            const { toastr } = installBrowserRuntimeStub();
            const recorder = makeNotifyRecorder();
            connectionMocks.sendSummarizerRequest.mockRejectedValue(new Error('timeout'));
            vi.useFakeTimers();

            const { outcome: pending } = runRequest({
                settings: makeSummarySettings({
                    fallbackConnectionSource: 'profile',
                    fallbackConnectionProfileId: 'backup',
                }),
                notify: recorder,
            });
            await vi.runAllTimersAsync();
            const outcome = await pending;

            expect(outcome.status).toBe('failed');
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
                2 * (RETRY_CONFIG.maxRetries + 1),
            );
            expect(toastr.error).not.toHaveBeenCalled();

            // Three retry waits per route, one route-cycle wait between the routes.
            const retryWaits = recorder.events.filter((e) => e.kind === NOTIFY_EVENTS.RETRY_WAIT);
            expect(retryWaits.map((e) => e.attempt)).toEqual([0, 1, 2, 0, 1, 2]);
            const routeCycleWaits = recorder.events.filter(
                (event) => event.kind === NOTIFY_EVENTS.ROUTE_CYCLE_WAIT,
            );
            expect(routeCycleWaits).toHaveLength(1);
            // Backoff band for the route-cycle attempt: base * multiplier to the
            // power of the retry budget, plus jitter; no Retry-After header on
            // the synthetic error.
            const band =
                RETRY_CONFIG.baseDelay * RETRY_CONFIG.backoffMultiplier ** RETRY_CONFIG.maxRetries;
            expect(routeCycleWaits[0].delayMs).toBeGreaterThanOrEqual(band);
            expect(routeCycleWaits[0].delayMs).toBeLessThan(band + RETRY_CONFIG.baseDelay);

            const kinds = recorder.events.map((event) => event.kind);
            expect(kinds.filter((kind) => kind === NOTIFY_EVENTS.RETRY_WAIT)).toHaveLength(6);
            expect(kinds.indexOf(NOTIFY_EVENTS.ROUTE_CYCLE_WAIT)).toBe(
                kinds.lastIndexOf(NOTIFY_EVENTS.RETRY_WAIT) + 1,
            );
            expect(kinds[kinds.length - 1]).toBe(NOTIFY_EVENTS.RUN_FAILED);
            expect(recorder.events[recorder.events.length - 1]).toEqual({
                type: 'transient',
                kind: NOTIFY_EVENTS.RUN_FAILED,
                retriesExhausted: true,
                attempts: 2 * (RETRY_CONFIG.maxRetries + 1),
                status: null,
            });
        });
    });

    describe('timeout retryability vs cancellation capability', () => {
        /**
         * The request mock never resolves, so every attempt hangs until its
         * timeout fires; the walk classifies each timeout the same way.
         */
        async function runHungWalk({ settings, notify }) {
            connectionMocks.sendSummarizerRequest.mockReturnValue(new Promise(() => {}));
            const pending = new RequestRunner().run(makeRequest({ settings, notify }));
            await vi.runAllTimersAsync();
            return await pending;
        }

        it('exposes the cancellation capability per registered provider', () => {
            expect(
                isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'default' }),
            ).toBe(false);
            expect(
                isCancellableConnection({ ...makeSummarySettings(), connectionSource: 'profile' }),
            ).toBe(true);
        });

        it('marks the timeout non-retryable on the uncancellable default route', async () => {
            vi.useFakeTimers();
            const recorder = makeNotifyRecorder();
            const outcome = await runHungWalk({
                settings: makeSummarySettings({
                    connectionSource: 'default',
                    requestTimeoutSeconds: 0.01,
                }),
                notify: recorder,
            });

            expect(outcome).toEqual({ status: 'failed', attempts: 1 });
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledOnce();
            expect(recorder.events[recorder.events.length - 1]).toEqual({
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: false,
                attempts: 1,
                status: null,
            });
        });

        it('keeps the timeout retryable on the cancellable profile route', async () => {
            vi.useFakeTimers();
            const recorder = makeNotifyRecorder();
            const outcome = await runHungWalk({
                settings: makeSummarySettings({
                    connectionSource: 'profile',
                    requestTimeoutSeconds: 0.01,
                }),
                notify: recorder,
            });

            expect(outcome).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
            expect(connectionMocks.sendSummarizerRequest).toHaveBeenCalledTimes(
                RETRY_CONFIG.maxRetries + 1,
            );
            expect(recorder.events[recorder.events.length - 1]).toMatchObject({
                kind: 'run-failed',
                retriesExhausted: true,
                attempts: RETRY_CONFIG.maxRetries + 1,
            });
        });
    });
});
