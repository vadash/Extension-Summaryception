// Ephemeral per-page Microfiche render cache: tab memory only, no
// persistence, no timers, no byte accounting. Text or geometry changes are
// plain key misses; an epoch drift clears the whole instance.

import { hashMicroficheShape } from './microfiche-pages.js';

/**
 * @typedef {object} MicroficheCachePage
 * @property {string} dataUrl - PNG data URL for the rendered page.
 * @property {string} text - Page text for the marker-expansion path.
 */

/**
 * @typedef {object} MicroficheCacheGetInput
 * @property {number} epoch - Mutation Epoch the derived pages belong to.
 * @property {string} text - Built injection text the pages render.
 * @property {import('./microfiche-paginate.js').MicroficheShape} shape - Resolved render shape.
 * @property {number} pageIndex - Page index within the live cap.
 * @property {unknown} effectiveCap - Live image cap for this render.
 * @property {() => MicroficheCachePage} render - Renders the page on a miss.
 */

/**
 * Hash built injection text with the same FNV-1a pass the entry prompt
 * hashing uses, so equal built text always keys equal.
 * @param {string} text - Built injection text.
 * @returns {string} Eight-hex-digit text hash.
 */
export function hashMicroficheText(text) {
    const source = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build one ephemeral per-page render cache. The instance lives beside the
 * injection writer and dies with it: chat switch and reload build a fresh
 * writer, so no explicit clear API exists.
 * @returns {{ getPage: (input: MicroficheCacheGetInput) => MicroficheCachePage | undefined, size: () => number }}
 */
export function createMicroficheRenderCache() {
    let epoch = null;
    /** @type {Map<string, MicroficheCachePage>} */
    const pages = new Map();

    /**
     * @param {MicroficheCacheGetInput} input
     * @returns {MicroficheCachePage | undefined}
     */
    function getPage({ epoch: nextEpoch, text, shape, pageIndex, effectiveCap, render }) {
        const cap = normalizeCap(effectiveCap);
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            return undefined;
        }
        if (epoch === null || nextEpoch !== epoch) {
            epoch = nextEpoch;
            pages.clear();
        }
        if (pageIndex >= cap) {
            return undefined;
        }
        evictKeysOutsideCap(cap);
        const key = buildKey(nextEpoch, text, shape, pageIndex);
        const hit = pages.get(key);
        if (hit !== undefined) {
            pages.delete(key);
            pages.set(key, hit);
            return hit;
        }
        const page = render();
        pages.set(key, page);
        trimToCap(cap);
        return page;
    }

    /**
     * Drop every entry outside the current live cap. Key order is insertion
     * order, which the LRU refresh keeps as recency order.
     * @param {number} cap - Live cap for this render.
     * @returns {void}
     */
    function evictKeysOutsideCap(cap) {
        for (const key of [...pages.keys()]) {
            if (pageIndexOf(key) >= cap) {
                pages.delete(key);
            }
        }
        trimToCap(cap);
    }

    /**
     * Evict the least recently used entries past the live cap. Map insertion
     * order is the recency order: hits reinsert, so the first keys are the
     * stalest.
     * @param {number} cap - Live cap for this render.
     * @returns {void}
     */
    function trimToCap(cap) {
        while (pages.size > cap) {
            const oldest = pages.keys().next();
            if (oldest.done) {
                return;
            }
            pages.delete(oldest.value);
        }
    }

    /**
     * @returns {number}
     */
    function size() {
        return pages.size;
    }

    return { getPage, size };
}

/**
 * @param {string} key - Cache key ending in the page index.
 * @returns {number} Page index, or -1 when the key is malformed.
 */
function pageIndexOf(key) {
    const tail = String(key).split(':').pop();
    const index = Number(tail);
    return Number.isSafeInteger(index) ? index : -1;
}

/**
 * @param {number} epoch
 * @param {string} text
 * @param {import('./microfiche-paginate.js').MicroficheShape} shape
 * @param {number} pageIndex
 * @returns {string}
 */
function buildKey(epoch, text, shape, pageIndex) {
    return `${String(epoch)}:${hashMicroficheText(text)}:${hashMicroficheShape(shape)}:${String(pageIndex)}`;
}

/**
 * @param {unknown} effectiveCap
 * @returns {number}
 */
function normalizeCap(effectiveCap) {
    const cap = Number(effectiveCap);
    if (!Number.isFinite(cap)) {
        return 0;
    }
    return Math.max(0, Math.floor(cap));
}
