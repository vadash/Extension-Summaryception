import { MEMORY_MODES } from '../foundation/constants.js';

/** Fraction of the queued chat budget the queue must fill before stale-cache advice fires. */
const STALE_ADVICE_MIN_QUEUE_FILL = 0.25;

/**
 * @typedef {object} StaleCacheAdvice
 * @property {boolean} advise True when summarizing now is cheaper than waiting.
 * @property {'cache-mode' | 'queue-small' | 'queue-thin' | 'unknown-time' | 'fresh' | 'stale'} reason Why the advice was given or withheld.
 * @property {number} staleMinutes Minutes since the last chat message, 0 when unknown.
 * @property {number} ttlMinutes Configured provider cache TTL in minutes.
 * @property {number} queuedTurns Assistant turns waiting in the summarize queue.
 * @property {number} queuedTokens Tokens waiting in the summarize queue.
 */

/**
 * @param {ExtensionSettings} settings
 * @returns {boolean}
 */
export function isProviderCacheMode(settings) {
    return settings?.memoryMode === MEMORY_MODES.PREFIX_CACHE;
}

/**
 * Read one message's creation time in epoch milliseconds.
 * SillyTavern writes `send_date` as an ISO string, but imported chats keep
 * legacy epoch milliseconds or humanized strings. Assistant messages also
 * carry `gen_started` / `gen_finished`. Returns null when no candidate parses.
 * @param {ChatMessage | undefined} message
 * @returns {number | null}
 */
export function getMessageTimestampMs(message) {
    const candidates = [message?.send_date, message?.gen_finished, message?.gen_started];
    for (const candidate of candidates) {
        const ms = coerceTimestampMs(candidate);
        if (ms !== null) {
            return ms;
        }
    }
    return null;
}

/**
 * Decide whether a loaded chat should summarize early because the provider
 * cache is stale. When the last message is older than the TTL, the next main
 * request pays full input price regardless, so flushing the queue first merges
 * the two full-price payments into one smaller one.
 * @param {{ chat: ChatMessage[], plan: object, settings: ExtensionSettings, now?: number }} input
 * @returns {StaleCacheAdvice}
 */
export function evaluateStaleCacheAdvice({ chat, plan, settings, now = Date.now() }) {
    const ttlMinutes = Number(settings?.cacheTtlMinutes) || 0;
    const queuedTurns = plan?.eligibleTurns?.length ?? 0;
    const queuedTokens = plan?.queuedTokens ?? 0;
    const advice = /** @type {StaleCacheAdvice} */ ({
        advise: false,
        reason: 'stale',
        staleMinutes: 0,
        ttlMinutes,
        queuedTurns,
        queuedTokens,
    });

    if (!isProviderCacheMode(settings)) {
        return { ...advice, reason: 'cache-mode' };
    }
    if (!hasSummarizableQueue(queuedTurns, settings)) {
        return { ...advice, reason: 'queue-small' };
    }
    if (!hasQueueTokenFill(queuedTokens, settings)) {
        return { ...advice, reason: 'queue-thin' };
    }

    const lastTimestampMs = getMessageTimestampMs(chat?.at(-1));
    if (lastTimestampMs === null) {
        return { ...advice, reason: 'unknown-time' };
    }

    const staleMinutes = minutesSince(lastTimestampMs, now);
    if (!isPastTtl(staleMinutes, ttlMinutes)) {
        return { ...advice, staleMinutes, reason: 'fresh' };
    }
    return { ...advice, staleMinutes, advise: true };
}

/**
 * Check whether enough assistant turns queue up to be worth a forced run.
 * @param {number} queuedTurns
 * @param {ExtensionSettings} settings
 * @returns {boolean}
 */
function hasSummarizableQueue(queuedTurns, settings) {
    return queuedTurns >= Math.max(1, Number(settings?.minSummaryTurns) || 0);
}

/**
 * Check whether queued tokens fill at least the advice fraction of the
 * queued chat budget.
 * @param {number} queuedTokens
 * @param {ExtensionSettings} settings
 * @returns {boolean}
 */
function hasQueueTokenFill(queuedTokens, settings) {
    const queuedBudget = Number(settings?.queuedTokenBudget) || 0;
    return queuedTokens >= STALE_ADVICE_MIN_QUEUE_FILL * queuedBudget;
}

/**
 * @param {number} timestampMs
 * @param {number} nowMs
 * @returns {number}
 */
function minutesSince(timestampMs, nowMs) {
    return Math.max(0, Math.floor((nowMs - timestampMs) / 60000));
}

/**
 * Check whether measured staleness reached the TTL (minimum one minute).
 * @param {number} staleMinutes
 * @param {number} ttlMinutes
 * @returns {boolean}
 */
function isPastTtl(staleMinutes, ttlMinutes) {
    return staleMinutes >= Math.max(1, ttlMinutes);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function coerceTimestampMs(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    if (/^\d+$/.test(value)) {
        const epochMs = Number(value);
        return epochMs > 0 ? epochMs : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
