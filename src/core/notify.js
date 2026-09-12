/**
 * Notify adapter seam (ADR-0004): core modules emit structured events, entry
 * renders every user-facing notice. The adapter is registered once at the
 * composition root (same pattern as the UI-updater setter); unregistered runs
 * fall back to a silent adapter.
 */

/**
 * @typedef {object} NotifyProgressEvent
 * @property {string} label - Stable progress kind owned by the emitting module.
 * @property {number} total - Total item count for the operation.
 */

/**
 * @typedef {object} NotifyUpdateEvent
 * @property {number} processed - Items processed so far.
 */

/**
 * @typedef {object} NotifyAdapter
 * @property {(event: Record<string, unknown>) => void} transient - One-shot notice; event carries structured data only.
 * @property {(event: NotifyProgressEvent) => unknown} progress - Open a long-lived progress handle.
 * @property {(handle: unknown, event: NotifyUpdateEvent) => void} update - Report progress counts; display cadence is adapter policy.
 * @property {(handle: unknown, event?: Record<string, unknown>) => void} clear - Close a handle, optionally with a terminal event.
 */

/** @type {NotifyAdapter} */
const silentAdapter = {
    transient() {},
    progress() {
        return null;
    },
    update() {},
    clear() {},
};

/** @type {NotifyAdapter} */
let notifyAdapter = silentAdapter;

/**
 * Register the notify adapter used by all core modules.
 * @param {NotifyAdapter | null | undefined} adapter - Toastr-backed adapter from entry, or a falsy value to reset.
 * @returns {void}
 */
export function setNotifyAdapter(adapter) {
    notifyAdapter = adapter || silentAdapter;
}

/**
 * Get the registered notify adapter, or the silent fallback when none is registered.
 * @returns {NotifyAdapter}
 */
export function getNotifyAdapter() {
    return notifyAdapter;
}
