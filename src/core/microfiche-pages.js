// Microfiche page glue: shape hashing, Canvas2D page builds, and the
// oldest-to-images / newest-K-text layout helper. Pure argument plumbing:
// no settings reads, no caps, no cache.

import { drawMicrofichePage } from './microfiche-render.js';

// Geometry keys only: the seam the cache ticket keys persistence on. Billing
// or provider hints never land here, so a key change always means new pixels.
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
 * Canonical string over geometry keys only, so equal reading geometry
 * hashes equal even when billing extras ride along.
 * @param {import('./microfiche-paginate.js').MicroficheShape & Record<string, unknown>} shape - Render shape.
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
 * @param {import('./microfiche-paginate.js').MicroficheShape} shape - Render shape.
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
 * Read pages back by index for the transport expansion seam.
 * @param {MicrofichePage[]} pages - Rendered pages in order.
 * @returns {(index: number) => MicrofichePage | undefined} Page reader.
 */
export function createMicrofichePageReader(pages) {
    const slots = Array.isArray(pages) ? pages : [];
    return (index) => slots[index];
}

/**
 * Totally order the snippets: the oldest outside the verbatim window become
 * image source, the newest K stay raw text.
 * @param {string[]} snippetTextsOldestFirst - Snippet texts in chronological order.
 * @param {number} keepRaw - Newest texts kept as raw text.
 * @returns {{ imageSource: string[], rawTail: string[] }} Image-bound and raw lists.
 */
export function splitMicroficheSnippets(snippetTextsOldestFirst, keepRaw) {
    const texts = Array.isArray(snippetTextsOldestFirst) ? snippetTextsOldestFirst : [];
    const count = Number.isFinite(keepRaw) ? Math.max(0, Math.floor(keepRaw)) : 0;
    const boundary = Math.max(0, texts.length - count);
    return { imageSource: texts.slice(0, boundary), rawTail: texts.slice(boundary) };
}
