// Parsed Microfiche fonts ready for the synchronous draw and normalize paths.
// The loader installs them once at entry init; this module stays import-free
// so normalize and the renderer can read the cache without a module cycle.

/**
 * @type {Map<string, import('./microfiche-fonts.js').MicroficheFont>}
 */
const fonts = new Map();

/**
 * Replace the parsed font set with the one the loader read.
 * @param {Record<string, import('./microfiche-fonts.js').MicroficheFont>} parsed - Fonts keyed by preset label.
 * @returns {void}
 */
export function installMicroficheFonts(parsed) {
    fonts.clear();
    for (const [name, font] of Object.entries(parsed)) {
        fonts.set(name, font);
    }
}

/**
 * Read one parsed font by preset label.
 * @param {string} name - Preset label from the render shape.
 * @returns {import('./microfiche-fonts.js').MicroficheFont | null} Parsed font, or null before the loader runs.
 */
export function getMicroficheFont(name) {
    return fonts.get(name) ?? null;
}
