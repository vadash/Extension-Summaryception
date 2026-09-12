import { describe, expect, it, vi } from 'vitest';

import { TOAST_TITLE } from '../src/foundation/constants.js';
import { formatTokenValue } from '../src/core/token-count.js';
import { createToastrNotifyAdapter } from '../src/entry/ui-dialogs.js';
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
 * counts; wording stays unasserted per house test rules.
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
        installBrowserRuntimeStub();
        const writes = installTextCapture();
        const adapter = createToastrNotifyAdapter();
        const handle = adapter.progress({ label: 'ghost-hide', total: 4 });

        adapter.update(handle, { processed: 1 });
        adapter.update(handle, { processed: 2 });

        expect(writes).toHaveLength(2);
        expect(writes[1]).toContain('2 / 4');
    });

    it('throttles unhide progress to every tenth processed item', () => {
        installBrowserRuntimeStub();
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

    it('ignores transient events with no entry mapping', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({ kind: 'unknown-event', count: 2 });

        expect(toastr.info).not.toHaveBeenCalled();
        expect(toastr.success).not.toHaveBeenCalled();
        expect(toastr.warning).not.toHaveBeenCalled();
        expect(toastr.error).not.toHaveBeenCalled();
    });

    it('shows a short stop notice for a run abort', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({ kind: 'run-aborted' });

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        const [, title, opts] = toastr.warning.mock.calls[0];
        expect(String(title)).toContain(TOAST_TITLE);
        expect(opts.timeOut).toBeGreaterThan(0);
        expect(opts.timeOut).toBeLessThan(10000);
    });

    it('shows a failure notice for a failed run', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({
            kind: 'run-failed',
            retriesExhausted: true,
            maxRetries: 3,
            status: 500,
        });

        expect(toastr.error).toHaveBeenCalledTimes(1);
        const [text, title, opts] = toastr.error.mock.calls[0];
        expect(String(title)).toContain(TOAST_TITLE);
        expect(String(text)).toContain('3');
        expect(String(text)).toContain('500');
        expect(opts.timeOut).toBeGreaterThan(0);
    });

    it('shows a guard notice built from structured token fields', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({
            kind: 'easy-guard-blocked',
            label: 'Layer 0 batch',
            tokens: 12345,
            estimated: false,
            limit: 8000,
        });

        expect(toastr.error).toHaveBeenCalledTimes(1);
        const [text, title, opts] = toastr.error.mock.calls[0];
        expect(String(title)).toContain(TOAST_TITLE);
        expect(String(text)).toContain(formatTokenValue(12345, false));
        expect(String(text)).toContain(formatTokenValue(8000, false));
        expect(opts.timeOut).toBeGreaterThan(0);
    });

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

    it('shows a route-cycle warning for a fixed duration', () => {
        const { toastr } = installBrowserRuntimeStub();
        const adapter = createToastrNotifyAdapter();

        adapter.transient({ kind: 'route-cycle-wait', delayMs: 60000 });

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][2].timeOut).toBeLessThan(60000);
    });
});
