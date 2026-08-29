import { LOG_PREFIX, MODULE_NAME, defaultSettings } from './constants.js';
import { getExtensionSettings } from './context.js';

function getDebugSettings() {
    try {
        const extensionSettings = getExtensionSettings();
        return extensionSettings[MODULE_NAME] || defaultSettings;
    } catch (_e) {
        return defaultSettings;
    }
}

/**
 * Check whether debug logging is enabled.
 * @returns {boolean}
 */
export function isDebugEnabled() {
    return Boolean(getDebugSettings().debugMode);
}

/**
 * Check whether trace logging is enabled.
 * @returns {boolean}
 */
export function isTraceEnabled() {
    const s = getDebugSettings();
    return Boolean(s.debugMode && s.traceMode);
}

/**
 * Check whether full LLM input logging is enabled.
 * @returns {boolean}
 */
export function isPromptInputLogEnabled() {
    return Boolean(getDebugSettings().promptInputLogMode);
}

/**
 * Check whether full LLM output logging is enabled.
 * @returns {boolean}
 */
export function isPromptOutputLogEnabled() {
    return Boolean(getDebugSettings().promptOutputLogMode);
}

/**
 * Check whether any full LLM prompt/response logging is enabled.
 * @returns {boolean}
 */
export function isPromptLogEnabled() {
    return isPromptInputLogEnabled() || isPromptOutputLogEnabled();
}

/**
 * Emit a low-frequency informational log when debug logging is enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function info(...args) {
    if (isDebugEnabled()) {
        console.log(LOG_PREFIX, ...args);
    }
}

/**
 * Emit a diagnostic log when debug logging is enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function debug(...args) {
    if (isDebugEnabled()) {
        console.log(LOG_PREFIX, '[DEBUG]', ...args);
    }
}

/**
 * Emit a high-volume trace log when debug and trace logging are enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function trace(...args) {
    if (isTraceEnabled()) {
        const normalized = args.map((arg, idx) =>
            idx === 0 && typeof arg === 'string' ? arg.toUpperCase() : arg,
        );
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

/**
 * Emit an always-visible warning.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/**
 * Emit an always-visible error.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function error(...args) {
    console.error(LOG_PREFIX, ...args);
}

/**
 * Coerce any thrown value into a plain object with the standard error fields.
 * @param {unknown} err - A thrown value. It can be an Error, a plain object, a string, or null.
 * @returns {{ name: string, message: string, status: number|null, retryable: boolean|null }}
 */
export function serializeError(err) {
    const e =
        /** @type {Error & { status?: number, statusCode?: number, retryable?: boolean | (() => boolean), response?: { status?: number } }} */ (
            err
        );
    return {
        name: (e && e.name) || 'Error',
        message: e && e.message ? e.message : String(e),
        status: (e && (e.status || e.statusCode || (e.response && e.response.status))) || null,
        retryable:
            e && typeof e.retryable === 'boolean'
                ? e.retryable
                : e && typeof e.retryable === 'function'
                  ? e.retryable()
                  : null,
    };
}

/**
 * Trace visible/owned chat counts for ghosting diagnostics.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {void}
 */
export function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  Total chat messages:', chat.length);

    const ownedIds = new Set(store.ghostedMessageIds);
    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    const visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message) {
            continue;
        }
        const owned = typeof message.sc_id === 'string' && ownedIds.has(message.sc_id);
        const messageText = message.mes?.trim() || '';
        if (!message.is_user && !message.is_system && !owned && messageText.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (owned) {
            ghostedCount++;
        }
        if (message.is_hidden || message.is_system) {
            hiddenCount++;
        }
    }

    trace('  Visible non-owned turns:', visibleCount);
    trace('  Summaryception-owned turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));
    trace('=== END DEBUG ===');
}
