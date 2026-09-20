/**
 * Notify adapter seam (ADR-0019): core modules emit structured events, entry
 * renders every user-facing notice. The adapter is created once at the
 * composition root and reaches core only through explicit arguments; callers
 * without one fall back to a silent adapter.
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
 * Structured transient event payload (ADR-0019). Core sends only the fields
 * its `kind` documents; entry views read only those fields.
 * @typedef {object} NotifyTransientEvent
 * @property {string} kind - Stable event kind from NOTIFY_EVENTS.
 * @property {boolean} [retriesExhausted] - Whether retries ran out (run-failed).
 * @property {number} [maxRetries] - Route retry budget (retry-wait).
 * @property {number} [attempts] - Attempts actually made (run-failed).
 * @property {number | null} [status] - HTTP status, when known (run-failed).
 * @property {string} [label] - Stable call label (easy-guard-blocked).
 * @property {number} [tokens] - Request token count (easy-guard-blocked).
 * @property {boolean} [estimated] - Token count is an estimate (easy-guard-blocked).
 * @property {number} [limit] - Configured token cap (easy-guard-blocked).
 * @property {number} [attempt] - Zero-based failed attempt index (retry-wait).
 * @property {number} [delayMs] - Backoff wait in ms; display ignores it (retry-wait).
 * @property {string} [percent] - CN ideograph percentage of visible characters (language-mix-retry).
 * @property {number} [mergedCount] - Snippets merged per promotion (promotion-started).
 * @property {number} [fromLayer] - Source layer index (promotion-started).
 * @property {number} [toLayer] - Destination layer index (promotion-started).
 */

/**
 * @typedef {object} NotifyAdapter
 * @property {(event: NotifyTransientEvent) => void} transient - One-shot notice; event carries structured data only.
 * @property {(event: NotifyProgressEvent) => unknown} progress - Open a long-lived progress handle.
 * @property {(handle: unknown, event: NotifyUpdateEvent) => void} update - Report progress counts; display cadence is adapter policy.
 * @property {(handle: unknown, event?: Record<string, unknown>) => void} clear - Close a handle, optionally with a terminal event.
 */

/** Default adapter used when a caller does not thread one in: drops every event. */
export const silentAdapter = {
    transient() {},
    progress() {
        return null;
    },
    update() {},
    clear() {},
};
