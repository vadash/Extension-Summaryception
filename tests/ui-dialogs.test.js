import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ELASTIC_STRATEGIES } from '../src/core/summarizer-engine.js';
import {
    createManualProgressToast,
    manualRunView,
    showStaleCacheAdvice,
    updateManualProgressToast,
} from '../src/entry/ui-dialogs.js';
import { makeToastrMock } from './test-helpers.js';

describe('showStaleCacheAdvice', () => {
    beforeEach(() => {
        globalThis.toastr = makeToastrMock();
    });

    it('shows a long-lived action toast for a stale cache', () => {
        showStaleCacheAdvice({
            advise: true,
            reason: 'stale',
            staleMinutes: 75,
            ttlMinutes: 30,
            queuedTurns: 5,
            queuedTokens: 4000,
        });

        expect(globalThis.toastr.info).toHaveBeenCalledTimes(1);
        const [message, title, options] = globalThis.toastr.info.mock.calls[0];
        expect(title).toContain('Stale Cache');
        expect(message).toContain('sc_stale_cache_force');
        expect(options).toMatchObject({
            closeButton: true,
            tapToDismiss: false,
            escapeHtml: false,
        });
    });
});

describe('manual run display policy', () => {
    beforeEach(() => {
        globalThis.toastr = makeToastrMock();
    });

    it('owns the progress text for each strategy', () => {
        expect(manualRunView(ELASTIC_STRATEGIES.FORCE)).toMatchObject({
            label: 'Processing',
            title: 'Summaryception Catch-Up',
        });
        expect(manualRunView(ELASTIC_STRATEGIES.SLOP)).toMatchObject({
            label: 'Breaking slop',
            title: 'Summaryception Slop Breaker',
        });
    });

    it('renders a progress toast from the strategy view', () => {
        createManualProgressToast(
            { completed: 1, failed: 0, totalBatches: 3 },
            manualRunView(ELASTIC_STRATEGIES.FORCE),
            () => {},
        );

        const [message, title, options] = globalThis.toastr.info.mock.calls[0];
        expect(title).toBe('Summaryception Catch-Up');
        expect(message).toBe('Processing: 1 / 3 batches (33%)');
        expect(options.timeOut).toBe(0);
    });

    it('rewords an open progress toast from the strategy view', () => {
        const text = vi.fn();
        globalThis.$ = vi.fn(() => ({ find: () => ({ text }) }));

        updateManualProgressToast(
            {},
            { completed: 2, failed: 1, totalBatches: 3 },
            manualRunView(ELASTIC_STRATEGIES.SLOP),
        );

        expect(text).toHaveBeenCalledWith(
            'Breaking slop: 2 / 3 batches (67%) | 1 failed\nClick x to pause',
        );
    });
});

describe('manual run notices', () => {
    beforeEach(() => {
        globalThis.toastr = makeToastrMock();
    });

    it('selects the catch-up notice by status and phrases it from the counts', () => {
        const { notices } = manualRunView(ELASTIC_STRATEGIES.FORCE);

        notices.completed({ status: 'completed', completed: 2, failed: 0, totalBatches: 2 });
        notices.partial({ status: 'partial', completed: 1, failed: 1, totalBatches: 4 });
        notices.aborted({ status: 'aborted', completed: 1, failed: 0, totalBatches: 4 });
        notices.failed({ status: 'failed', completed: 1, failed: 3, totalBatches: 4 });

        expect(globalThis.toastr.success).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain('will retry on next trigger');
        expect(globalThis.toastr.warning.mock.calls[1][0]).toContain('Progress saved');
    });

    it('separates a gate block before the run from one mid-run by the batch count', () => {
        const { notices } = manualRunView(ELASTIC_STRATEGIES.FORCE);

        notices.blocked({ status: 'blocked', completed: 0, failed: 0, totalBatches: 0 });
        notices.blocked({ status: 'blocked', completed: 1, failed: 0, totalBatches: 4 });

        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain(
            'Foreground generation is active',
        );
        expect(globalThis.toastr.warning.mock.calls[1][0]).toContain('paused at 1/4');
    });

    it('renders the idle notice the strategy owns', () => {
        const idle = { status: 'idle', completed: 0, failed: 0, totalBatches: 0 };

        manualRunView(ELASTIC_STRATEGIES.FORCE).notices.idle(idle);
        manualRunView(ELASTIC_STRATEGIES.SLOP).notices.idle(idle);

        expect(globalThis.toastr.info.mock.calls[0][0]).toContain('Nothing eligible');
        expect(globalThis.toastr.info.mock.calls[1][0]).toContain('Nothing to reset');
    });

    it('reads the completed count for slop notices', () => {
        const { notices } = manualRunView(ELASTIC_STRATEGIES.SLOP);

        notices.blocked({ status: 'blocked', completed: 0, failed: 0, totalBatches: 0 });
        notices.failed({ status: 'failed', completed: 0, failed: 1, totalBatches: 2 });
        notices.partial({ status: 'partial', completed: 1, failed: 1, totalBatches: 2 });

        expect(globalThis.toastr.warning.mock.calls[0][0]).toContain(
            'Foreground generation is active',
        );
        expect(globalThis.toastr.error.mock.calls[0][0]).toContain('No new cut was completed');
        expect(globalThis.toastr.warning.mock.calls[1][0]).toContain('paused after 1 batch.');
    });
});
