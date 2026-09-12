import { describe, expect, it, vi } from 'vitest';

import { TOAST_TITLE } from '../src/foundation/constants.js';
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
});
