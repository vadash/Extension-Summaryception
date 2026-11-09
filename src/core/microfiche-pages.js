// Microfiche page source: the one page-owning module. Consumers bind the plan,
// then read page N by index; the Raw Seal, the per-page cache, its per-epoch
// clear, and canvas capture stay behind this seam.

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
 * @property {{ shape: import('./microfiche-geometry.js').MicroficheShape, imageTexts: string[] } | null} plan - Plan owning the page list and render shape.
 * @property {string} [text] - Accepted for caller compatibility; pages render from the sealed plan, so this value is not retained.
 * @property {number} epoch - Mutation Epoch the sealed pages belong to.
 */

/**
 * @typedef {object} MicrofichePageSource
 * @property {(input: MicrofichePageSourceInput) => void} update - Seal the plan for the epoch, then warm every sealed page.
 * @property {(pageIndex: number) => MicrofichePage | undefined} readPage - Read one page by index.
 * @property {() => number} size - Cached page count.
 * @property {() => void} reset - Drop the sealed plan and every cached page, for a chat switch where the epoch can repeat.
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
 * page index. The cache is tab memory only. Epoch and geometry drift clear it,
 * and a chat switch calls reset because each chat's mutation epoch starts at
 * zero and can repeat the epoch this chat sealed.
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
    /** @type {{ epoch: number, shapeHash: string, plan: MicrofichePageSourceInput['plan'] } | null} */
    let sealed = null;
    /** @type {Map<number, MicrofichePage>} */
    const pages = new Map();

    /**
     * Seal the plan on the first update of an epoch or a geometry change. Raw
     * chat growth does not bump the epoch, so a later update inside the same
     * epoch reuses the sealed page list and its pixels.
     * @param {MicrofichePageSourceInput} input - Plan and epoch; other fields are accepted and ignored.
     * @returns {void}
     */
    function update({ plan, epoch }) {
        const shapeHash =
            plan === null || plan === undefined ? '' : hashMicroficheShape(plan.shape);
        if (sealed === null || sealed.epoch !== epoch || sealed.shapeHash !== shapeHash) {
            pages.clear();
            sealed = {
                epoch,
                shapeHash,
                plan:
                    plan === null || plan === undefined
                        ? null
                        : {
                              ...plan,
                              imageTexts: Array.isArray(plan.imageTexts)
                                  ? [...plan.imageTexts]
                                  : [],
                          },
            };
        }
        const imageTexts = sealed.plan?.imageTexts;
        const pageCount = Array.isArray(imageTexts) ? imageTexts.length : 0;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            readPage(pageIndex);
        }
    }

    /**
     * @param {number} pageIndex - Page index within the sealed plan.
     * @returns {MicrofichePage | undefined} Cached page or undefined.
     */
    function readPage(pageIndex) {
        if (sealed === null || renderer === null) {
            return undefined;
        }
        const plan = sealed.plan;
        if (plan === null || plan === undefined || !Array.isArray(plan.imageTexts)) {
            return undefined;
        }
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            return undefined;
        }
        // The sealed page list is the cap: a reader never slices it itself.
        if (pageIndex >= plan.imageTexts.length) {
            return undefined;
        }
        const hit = pages.get(pageIndex);
        if (hit !== undefined) {
            return hit;
        }
        const page = renderer(plan.imageTexts[pageIndex], plan.shape);
        pages.set(pageIndex, page);
        return page;
    }

    /**
     * @returns {number}
     */
    function size() {
        return pages.size;
    }

    /**
     * Drop the sealed plan and every cached page. A chat switch calls this
     * because the next chat's epoch can equal the sealed one, so epoch
     * equality alone cannot prove the pixels belong to the loaded chat.
     * @returns {void}
     */
    function reset() {
        sealed = null;
        pages.clear();
    }

    return { update, readPage, size, reset };
}
