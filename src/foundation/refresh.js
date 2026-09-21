/**
 * Refresh port: the one interface that syncs visible UI and prompt injection
 * after state changes. Entry registers the effects once at the composition
 * root. Callers pick a scope. Callers without a registered port fall back to
 * silent no-ops, mirroring the notify silent adapter.
 */

/** @type {{ updateInjection: (options?: object) => void, updateContinuityInjection?: () => void, updateContinuityMarker?: () => void, updateUI: () => void, updatePreview: () => void } | null} */
let effects = null;

/**
 * @param {{ updateInjection: (options?: object) => void, updateContinuityInjection?: () => void, updateContinuityMarker?: () => void, updateUI: () => void, updatePreview: () => void }} port
 * @returns {void}
 */
export function initRefreshPort(port) {
    effects = port;
}

function fire(effect) {
    if (typeof effect === 'function') {
        effect();
    }
}

/**
 * Re-render the settings UI only.
 * @returns {void}
 */
export function refreshUi() {
    fire(effects?.updateContinuityMarker);
    fire(effects?.updateUI);
}

/**
 * Update injection, then re-render the UI that reads injection-derived state.
 * @returns {void}
 */
export function refreshFull() {
    fire(effects?.updateInjection);
    fire(effects?.updateContinuityInjection);
    fire(effects?.updateContinuityMarker);
    fire(effects?.updateUI);
}

/**
 * Update injections, then re-render the context preview only.
 * @returns {void}
 */
export function refreshPreview() {
    fire(effects?.updateInjection);
    fire(effects?.updateContinuityInjection);
    fire(effects?.updateContinuityMarker);
    fire(effects?.updatePreview);
}

/**
 * Update the committed injection alone, carrying the caller's options. The
 * Snippet Commit seam re-syncs the injection through this effect, so the
 * refresh crosses the Foreground Gate like every other prompt write.
 * @param {object} [options]
 * @returns {void}
 */
export function refreshInjection(options = {}) {
    const effect = effects?.updateInjection;
    if (typeof effect === 'function') {
        effect(options);
    }
}
