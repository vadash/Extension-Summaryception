import {
    MEMORY_MODES,
    MICROFICHE_GEOMETRY_PRESETS,
    NOTIFY_EVENTS,
} from '../foundation/constants.js';

/** Host capability the gate reads from its injected adapter, never the connection registry. */
export const MICROFICHE_READER_CAPABILITY = 'image-inline';

/**
 * @param {ExtensionSettings | null | undefined} settings
 * @returns {boolean}
 */
export function isMicroficheMode(settings) {
    return settings?.memoryMode === MEMORY_MODES.MICROFICHE;
}

/**
 * @param {ExtensionSettings | null | undefined} settings
 * @returns {Array<string>}
 */
export function resolveMicroficheReaders(settings) {
    if (!isMicroficheMode(settings)) {
        return [];
    }
    const preset =
        MICROFICHE_GEOMETRY_PRESETS[
            /** @type {'gemini' | 'deepseek' | 'glm' | 'custom'} */ (settings?.microficheGeometry)
        ];
    return [...(preset?.readers ?? [])];
}

/**
 * @param {{ settings?: ExtensionSettings | null, host?: { canInlineImages?: unknown, imageBudget?: unknown } | null }} [input]
 * @returns {{ ok: true } | { ok: false, reason: 'no-readers' | 'no-vision' }}
 */
export function checkMicroficheReadiness({ settings = null, host = null } = {}) {
    if (!isMicroficheMode(settings)) {
        return { ok: true };
    }
    if (resolveMicroficheReaders(settings).length === 0) {
        return { ok: false, reason: 'no-readers' };
    }
    if (host?.canInlineImages === true) {
        return { ok: true };
    }
    return { ok: false, reason: 'no-vision' };
}

/**
 * @param {{ settings?: ExtensionSettings | null, host?: { canInlineImages?: unknown, imageBudget?: unknown } | null, notify?: import('./notify.js').NotifyAdapter | null }} [input]
 * @returns {{ ok: true } | { ok: false, reason: 'no-readers' | 'no-vision' }}
 */
export function gateMicroficheMode({ settings = null, host = null, notify = null } = {}) {
    const result = checkMicroficheReadiness({ settings, host });
    if (result.ok) {
        return result;
    }
    notify?.transient?.({
        kind:
            result.reason === 'no-readers'
                ? NOTIFY_EVENTS.MICROFICHE_GEOMETRY_BLOCKED
                : NOTIFY_EVENTS.MICROFICHE_READER_BLOCKED,
    });
    return result;
}
