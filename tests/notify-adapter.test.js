import { describe, expect, it, vi } from 'vitest';

import { BATCH_PROGRESS, TOAST_TITLE } from '../src/foundation/constants.js';
import { formatTokenValue } from '../src/core/token-count.js';
import {
    createToastrNotifyAdapter,
    pauseMemoryToastForGeneration,
} from '../src/entry/ui-dialogs.js';
import { installBrowserRuntimeStub } from './test-helpers.js';

/** Install a $ stub (via the shared runtime stub) that records progress text writes. */
function installTextCapture() {
    const writes = [];
    installBrowserRuntimeStub({
        $: vi.fn(() => ({
            find: () => ({ text: (value) => writes.push(String(value)) }),
        })),
    });
    return writes;
}

/**
 * The entry adapter maps structured notify events onto toastr (ADR-0004).
 * Tests assert notification kind, persistence, cadence, and processed/total
 * counts. Wording stays unasserted per house test rules.
 */
describe('toastr notify adapter mapping', () => {
    it('opens one persistent info toast per progress handle', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        const handle = adapter.progress({ label: 'ghost-hide', total: 4 });

        expect(toastr.info).toHaveBeenCalledTimes(1);
        const [text, title, opts] = toastr.info.mock.calls[0];
        expect(String(text)).toContain('0 / 4');
        expect(String(title)).toContain(TOAST_TITLE);
        expect(opts.timeOut).toBe(0);
        expect(opts.tapToDismiss).toBe(false);
        expect(handle).toBeTruthy();
    });

    it('renders hide progress on every processed count', () => {
        const writes = installTextCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: 'ghost-hide', total: 4 });

        adapter.update(handle, { processed: 1 });
        adapter.update(handle, { processed: 2 });

        expect(writes).toHaveLength(2);
        expect(writes[1]).toContain('2 / 4');
    });

    it('throttles unhide progress to every tenth processed item', () => {
        const writes = installTextCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: 'ghost-unhide', total: 12 });

        adapter.update(handle, { processed: 3 });
        expect(writes).toHaveLength(0);

        adapter.update(handle, { processed: 10 });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('10 / 12');
    });

    it('clears the toast handle and tolerates a null handle', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: 'ghost-hide', total: 4 });
        const toast = toastr.info.mock.results[0].value;

        adapter.clear(handle);
        adapter.clear(null);

        expect(toastr.clear).toHaveBeenCalledTimes(1);
        expect(toastr.clear).toHaveBeenCalledWith(toast);
    });

    it('opens the batch progress as a persistent bar toast under the bare title', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 3 });

        expect(toastr.info).toHaveBeenCalledTimes(1);
        const [text, title, opts] = toastr.info.mock.calls[0];
        expect(String(title)).toBe(TOAST_TITLE);
        expect(String(text)).not.toContain('0 / 3');
        expect(opts.timeOut).toBe(0);
        expect(opts.extendedTimeOut).toBe(0);
        expect(opts.tapToDismiss).toBe(false);
        expect(opts.progressBar).toBe(true);
    });

    it('ignores processed counts for the batch progress view', () => {
        const writes = installTextCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 3 });

        adapter.update(handle, { processed: 1 });
        adapter.update(handle, { processed: 3 });

        expect(writes).toHaveLength(0);
    });

    it('closes the batch progress with a success terminal on commit', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 1 });
        const toast = toastr.info.mock.results[0].value;

        adapter.clear(handle, { kind: BATCH_PROGRESS.UPDATED });

        expect(toastr.clear).toHaveBeenCalledTimes(1);
        expect(toastr.clear).toHaveBeenCalledWith(toast);
        expect(toastr.success).toHaveBeenCalledTimes(1);
        expect(toastr.success.mock.calls[0][2].timeOut).toBeGreaterThan(0);
        expect(toastr.warning).not.toHaveBeenCalled();
    });

    it('closes the batch progress with a warning terminal on failure', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 1 });

        adapter.clear(handle, { kind: BATCH_PROGRESS.FAILED });

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][2].timeOut).toBeGreaterThan(0);
        expect(toastr.success).not.toHaveBeenCalled();
    });

    it('ignores transient events with no entry mapping', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({ kind: 'unknown-event', count: 2 });

        expect(toastr.info).not.toHaveBeenCalled();
        expect(toastr.success).not.toHaveBeenCalled();
        expect(toastr.warning).not.toHaveBeenCalled();
        expect(toastr.error).not.toHaveBeenCalled();
    });
    // Severity, fragments, and non-persistence are the adapter contract. The
    // entry owns the exact display durations (ADR-0004).
    it.each([
        {
            event: { kind: 'run-aborted' },
            method: 'warning',
            fragments: [],
        },
        {
            event: { kind: 'run-failed', retriesExhausted: true, attempts: 3, status: 500 },
            method: 'error',
            fragments: ['3', '500'],
        },
        {
            event: {
                kind: 'easy-guard-blocked',
                label: 'Layer 0 batch',
                tokens: 12345,
                estimated: false,
                limit: 8000,
            },
            method: 'error',
            fragments: [formatTokenValue(12345, false), formatTokenValue(8000, false)],
        },
        {
            event: { kind: 'route-cycle-wait', delayMs: 60000 },
            method: 'warning',
            fragments: [],
        },
        {
            event: { kind: 'language-mix-retry', percent: '23.4' },
            method: 'warning',
            fragments: ['23.4'],
        },
        {
            event: { kind: 'promotion-started', mergedCount: 3, fromLayer: 0, toLayer: 1 },
            method: 'info',
            fragments: ['3', 'Layer 0', 'Layer 1'],
            options: { progressBar: true },
        },
    ])(
        'maps the $event.kind transient event onto toastr.$method',
        ({ event, method, fragments, options }) => {
            const { toastr } = installBrowserRuntimeStub();
            const adapter = createToastrNotifyAdapter();

            adapter.transient(event);

            expect(toastr[method]).toHaveBeenCalledTimes(1);
            const [text, title, opts] = toastr[method].mock.calls[0];
            expect(String(title)).toContain(TOAST_TITLE);
            for (const fragment of fragments) {
                expect(String(text)).toContain(fragment);
            }
            for (const [name, value] of Object.entries(options ?? {})) {
                expect(opts[name]).toBe(value);
            }
            // Transient notices auto-dismiss. Only the persistent progress
            // toasts pin timeOut to zero.
            expect(opts.timeOut).toBeGreaterThan(0);
        },
    );

    it('shows retry warnings for a fixed duration that ignores the wait', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({ kind: 'retry-wait', attempt: 0, delayMs: 60000, maxRetries: 3 });
        const longWait = toastr.warning.mock.calls[0][2].timeOut;
        adapter.transient({ kind: 'retry-wait', attempt: 1, delayMs: 2000, maxRetries: 3 });
        const shortWait = toastr.warning.mock.calls[1][2].timeOut;

        expect(toastr.warning).toHaveBeenCalledTimes(2);
        expect(longWait).toBe(shortWait);
        expect(longWait).toBeLessThan(60000);
    });

    /** Like installTextCapture, but the memory toast element resolves. */
    function installPauseCapture() {
        const writes = installTextCapture();
        const toastr = globalThis.toastr;
        toastr.info.mockImplementation(() => ({}));
        return { writes, toastr };
    }

    it('rewords an open memory toast when a foreground generation pauses it', () => {
        const { writes, toastr } = installPauseCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 2 });
        const [staticText] = toastr.info.mock.calls[0];

        pauseMemoryToastForGeneration();

        expect(writes).toHaveLength(1);
        expect(writes[0]).not.toBe(String(staticText));

        adapter.clear(handle, { kind: BATCH_PROGRESS.ABORTED });
    });

    it('leaves non-memory progress toasts untouched on pause', () => {
        const { writes } = installPauseCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: 'ghost-hide', total: 4 });

        pauseMemoryToastForGeneration();

        expect(writes).toHaveLength(0);

        adapter.clear(handle);
    });

    it('keeps the memory pause a no-op after the toast closes', () => {
        const { writes } = installPauseCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: BATCH_PROGRESS.MEMORY, total: 1 });
        adapter.clear(handle, { kind: BATCH_PROGRESS.UPDATED });

        pauseMemoryToastForGeneration();

        expect(writes).toHaveLength(0);
    });
});
