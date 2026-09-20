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
