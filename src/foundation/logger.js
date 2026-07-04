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
 *
 */
export function log(...args) {
    if (isDebugEnabled()) {
        console.log(LOG_PREFIX, ...args);
    }
}

/**
 *
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
 *
 */
export function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    const visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) {
            ghostedCount++;
        }
        if (m.is_hidden || m.is_system) {
            hiddenCount++;
        }
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    const unghosteredSummarized = visibleIndices.filter((idx) => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace(
            '  WARNING: Found ' +
                unghosteredSummarized.length +
                ' visible messages that are BEFORE summarizedUpTo!',
        );
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}
