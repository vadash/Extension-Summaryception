// Microfiche page source: the one page-owning module. Consumers bind the live
// plan, then read page N; the ephemeral per-page cache, its cap and LRU
// eviction, and canvas capture stay behind this seam.

import { drawMicrofichePage } from './microfiche-render.js';

// Geometry keys only: a key change always means new pixels. Billing or
// provider hints never land here.
const SHAPE_HASH_KEYS = [
    'font',
    'cellWidth',
    'cellHeight',
    'stretch',
    'variant',
    'stopwordDim',
    'columns',
    'lineRepeat',
    'frameSize',
];

/**
 * @typedef {object} MicrofichePage
 * @property {string} dataUrl - PNG data URL for the rendered page.
 * @property {string} text - Page text for the marker-expansion path.
 */

/**
 * @typedef {object} MicrofichePageSourceInput
 * @property {{ shape: import('./microfiche-geometry.js').MicroficheShape, imageTexts: string[] } | null} plan - Live plan owning the page list and render shape.
 * @property {string} text - Built injection text the pages render.
 * @property {number} epoch - Mutation Epoch the derived pages belong to.
 */

/**
 * @typedef {object} MicrofichePageSource
 * @property {(input: MicrofichePageSourceInput) => void} update - Bind the live plan and warm every live page.
 * @property {(pageIndex: number) => MicrofichePage | undefined} readPage - Read one page by index.
 * @property {() => number} size - Cached page count.
 */

/**
 * Canonical string over geometry keys only, so equal reading geometry
 * hashes equal even when billing extras ride along.
 * @param {import('./microfiche-geometry.js').MicroficheShape & Record<string, unknown>} shape - Render shape.
 * @returns {string} Canonical key string.
 */
export function hashMicroficheShape(shape) {
    return SHAPE_HASH_KEYS.map((key) => `${key}=${String(shape?.[key])}`).join('|');
}

/**
 * Render ordered page strings into transport pages. The draw runs on one
 * injected canvas per page, and toDataURL runs on that same canvas, so the
 * image matches the laid-out text. Input order in, page order out.
 * @param {string[]} imageTexts - Page strings in chronological order.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {(width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, font: string, textBaseline: string, fillRect: (x: number, y: number, w: number, h: number) => void, fillText: (text: string, x: number, y: number) => void } }} canvasFactory - Injected canvas source.
 * @returns {MicrofichePage[]} Pages in input order.
 */
export function renderMicrofichePages(imageTexts, shape, canvasFactory) {
    const texts = Array.isArray(imageTexts) ? imageTexts : [];
    return texts.map((text) => {
        /** @type {{ canvas: { toDataURL: (mime?: string) => string }, ctx: object } | undefined} */
        let drawn;
        const captureFactory = (width, height) => {
            const made = canvasFactory(width, height);
            drawn = made;
            return made;
        };
        drawMicrofichePage(String(text), shape, captureFactory);
        const dataUrl =
            drawn && typeof drawn.canvas.toDataURL === 'function'
                ? drawn.canvas.toDataURL('image/png')
                : 'data:image/png;base64,';
        return { dataUrl, text: String(text) };
    });
}

/**
 * Build the one page source: readers bind a plan with update, then ask for a
 * page index. The cache is tab memory only and dies with the instance, so a
 * chat switch or reload that rebuilds the owner needs no explicit clear.
 * @param {{
 *   canvasFactory?: ((width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, font: string, textBaseline: string, fillRect: (x: number, y: number, w: number, h: number) => void, fillText: (text: string, x: number, y: number) => void } }) | null,
 *   renderPage?: ((text: string, shape: import('./microfiche-geometry.js').MicroficheShape) => MicrofichePage) | null,
 * }} [deps] - Injected canvas source or per-page renderer.
 * @returns {MicrofichePageSource} Page source.
 */
export function createMicrofichePageSource({ canvasFactory = null, renderPage = null } = {}) {
    const renderer =
        typeof renderPage === 'function'
            ? renderPage
            : canvasFactory !== null && canvasFactory !== undefined
              ? (text, shape) => renderMicrofichePages([text], shape, canvasFactory)[0]
              : null;
    /** @type {MicrofichePageSourceInput | null} */
    let live = null;
    /** @type {number | null} */
    let cacheEpoch = null;
    /** @type {Map<string, MicrofichePage>} */
    const pages = new Map();

    /**
     * @param {MicrofichePageSourceInput} input - Live plan, built text, and epoch.
     * @returns {void}
     */
    function update({ plan, text, epoch }) {
        live = { plan, text, epoch };
        const imageTexts = plan?.imageTexts;
        const pageCount = Array.isArray(imageTexts) ? imageTexts.length : 0;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            readPage(pageIndex);
        }
    }

    /**
     * @param {number} pageIndex - Page index within the live plan.
     * @returns {MicrofichePage | undefined} Cached page or undefined.
     */
    function readPage(pageIndex) {
        if (live === null || renderer === null) {
            return undefined;
        }
        const plan = live.plan;
        if (plan === null || plan === undefined || !Array.isArray(plan.imageTexts)) {
            return undefined;
        }
        const imageTexts = plan.imageTexts;
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            return undefined;
        }
        if (cacheEpoch === null || live.epoch !== cacheEpoch) {
            cacheEpoch = live.epoch;
            pages.clear();
        }
        // The live page list is the cap: a reader never slices it itself.
        const cap = imageTexts.length;
        if (pageIndex >= cap) {
            return undefined;
        }
        evictKeysOutsideCap(cap);
        const key = buildKey(live.epoch, live.text, plan.shape, pageIndex);
        const hit = pages.get(key);
        if (hit !== undefined) {
            pages.delete(key);
            pages.set(key, hit);
            return hit;
        }
        const page = renderer(imageTexts[pageIndex], plan.shape);
        pages.set(key, page);
        trimToCap(cap);
        return page;
    }

    /**
     * Drop every entry outside the live cap. Key order is insertion order,
     * which the LRU refresh keeps as recency order.
     * @param {number} cap - Live page count.
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
     * @param {number} cap - Live page count.
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

    return { update, readPage, size };
}

/**
 * Hash built injection text with the same FNV-1a pass the entry prompt
 * hashing uses, so equal built text always keys equal.
 * @param {string} text - Built injection text.
 * @returns {string} Eight-hex-digit text hash.
 */
function hashMicroficheText(text) {
    const source = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
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
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape
 * @param {number} pageIndex
 * @returns {string}
 */
function buildKey(epoch, text, shape, pageIndex) {
    return `${String(epoch)}:${hashMicroficheText(text)}:${hashMicroficheShape(shape)}:${String(pageIndex)}`;
}
