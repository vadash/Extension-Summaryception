// Microfiche policy: the one owner of cap reconciliation, the Fill Gate, and
// the oldest-to-images / newest-K-text split. Readers consume the plan, so the
// preview count and the injected split always agree.

import { MICROFICHE_GEOMETRY_PRESETS } from '../foundation/constants.js';
import { charCells, frameGrid, usesWideCells } from './microfiche-geometry.js';
import { buildMicrofichePageTexts, resolveMicroficheShape } from './microfiche-paginate.js';
import { resolveRawChatBucketTokens } from './token-budget.js';

// A page images only when it fills at least three quarters of its capacity.
// The trailing partial page stays text, because an underfilled frame spends a
// full image cost for little covered text.
const MICROFICHE_FILL_GATE_RATIO = 0.75;
// Same fallback ratio as the plain-text token estimator. The bucket gate only
// needs the raw text that stays text, not a tokenizer-precise count.
const RAW_TEXT_CHARS_PER_TOKEN = 4;

/**
 * @typedef {object} MicrofichePlan
 * @property {import('./microfiche-geometry.js').MicroficheShape} shape - Resolved render shape.
 * @property {number} keepRaw - Normalized newest-K raw-text count.
 * @property {number} effectiveCap - Images per injection after budget reconciliation.
 * @property {string[]} imageTexts - Fill-gated page texts bound for image frames.
 * @property {string[]} rawTexts - Gated tail, overflow pages, then kept-raw texts, in order.
 * @property {number} frameTokenEstimate - Image-token estimate per frame, or 0 for custom.
 */

/**
 * Fewest images the slider, host, and preset budgets all allow. Absent
 * budgets read as unbounded, garbage reads as zero so overflow stays text.
 * @param {unknown} sliderCap - Slider images-per-injection cap.
 * @param {unknown} hostBudget - Host adapter image budget, if any.
 * @param {unknown} presetBudget - Preset image budget, if any.
 * @returns {number} Effective image cap, floored at zero.
 */
export function resolveMicroficheEffectiveCap(sliderCap, hostBudget, presetBudget) {
    const candidates = [sliderCap, hostBudget, presetBudget]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(0, Math.floor(value)));
    if (candidates.length === 0) {
        return 0;
    }
    return Math.min(...candidates);
}

/**
 * Split oldest-first snippet texts: the oldest paginate to images, the
 * newest K stay raw. keepRaw 0 means all-to-images; keepRaw past the input
 * length keeps everything raw.
 * @param {string[]} textsOldestFirst - Snippet texts in chronological order.
 * @param {number} keepRaw - Newest texts kept as raw text.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Image-bound and raw text lists.
 */
export function splitMicroficheTexts(textsOldestFirst, keepRaw) {
    const texts = Array.isArray(textsOldestFirst) ? textsOldestFirst : [];
    const count = normalizeKeepRaw(keepRaw);
    const boundary = Math.max(0, texts.length - count);
    return { imageTexts: texts.slice(0, boundary), rawTexts: texts.slice(boundary) };
}

/**
 * One plan every Microfiche reader consumes: shape, cap, fill gate, split, and
 * the per-frame image-token estimate. Unknown geometry carries no preset budget
 * and no frame estimate, so custom stays fully slider/host driven.
 * @param {string[]} textsOldestFirst - Snippet texts in chronological order.
 * @param {Record<string, unknown>} settings - Settings carrying knobs, slider cap, and preset name.
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @returns {MicrofichePlan} Built plan.
 */
export function buildMicrofichePlan(textsOldestFirst, settings, host = null) {
    const source = settings ?? {};
    const shape = resolveMicroficheShape(source);
    const name = String(source.microficheGeometry ?? '');
    const preset = MICROFICHE_GEOMETRY_PRESETS[name] ?? null;
    const presetRecord = /** @type {Record<string, unknown>} */ (preset ?? {});
    const presetBudget = 'imageBudget' in presetRecord ? presetRecord.imageBudget : undefined;
    const hostBudget =
        host !== null && host !== undefined
            ? /** @type {{ imageBudget?: unknown }} */ (host).imageBudget
            : undefined;
    const effectiveCap = resolveMicroficheEffectiveCap(
        source.microficheImageCap,
        hostBudget,
        presetBudget,
    );
    const keepRaw = Number(source.microficheKeepRaw);
    const split = splitMicroficheTexts(textsOldestFirst, keepRaw);
    const pages = buildMicrofichePageTexts(split.imageTexts, shape);
    const filled = applyFillGate(pages.imageTexts, shape);
    const imageTexts = filled.imageTexts.slice(0, effectiveCap);
    const rawTexts = [
        ...filled.imageTexts.slice(effectiveCap),
        ...filled.rawTexts,
        ...split.rawTexts,
    ];
    const frameTokenEstimate = Number(presetRecord.frameTokenEstimate);
    const estimate =
        Number.isFinite(frameTokenEstimate) && frameTokenEstimate > 0 ? frameTokenEstimate : 0;
    const budgeted = applyBucketGate(imageTexts, rawTexts, estimate, source);
    return {
        shape,
        keepRaw: normalizeKeepRaw(keepRaw),
        effectiveCap,
        imageTexts: budgeted.imageTexts,
        rawTexts: budgeted.rawTexts,
        frameTokenEstimate: estimate,
    };
}

/**
 * Keep only the leading pages that fill at least the gate ratio. Pagination
 * fills pages in order, so only the trailing page can fall short.
 * @param {string[]} pages - Page strings in order.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Gated images plus the trailing text pages.
 */
function applyFillGate(pages, shape) {
    const imageTexts = pages.slice();
    const rawTexts = [];
    const geo = frameGrid(shape, shape.frameSize);
    while (imageTexts.length > 0) {
        const last = imageTexts[imageTexts.length - 1];
        if (pageFillRatio(last, shape, geo) >= MICROFICHE_FILL_GATE_RATIO) {
            break;
        }
        rawTexts.unshift(/** @type {string} */ (imageTexts.pop()));
    }
    return { imageTexts, rawTexts };
}

/**
 * Fraction of a page's capacity the page text occupies.
 * @param {string} page - Page string.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {import('./microfiche-geometry.js').MicroficheGeometry} geo - Frame grid.
 * @returns {number} Fill ratio from 0 to 1.
 */
function pageFillRatio(page, shape, geo) {
    if (shape.columns === 2) {
        const lines = String(page).split('\n').length;
        return Math.min(1, lines / Math.max(1, 2 * geo.rows));
    }
    const wideCells = usesWideCells(shape);
    let cells = 0;
    for (const ch of String(page)) {
        cells += charCells(ch, wideCells);
    }
    return geo.capacity > 0 ? Math.min(1, cells / geo.capacity) : 0;
}

/**
 * Image tokens spend from the same raw-chat bucket as the text kept raw. Drop
 * the newest image pages until the billed total fits, because an image that
 * does not fit waits for the next memory update instead of inflating context.
 * @param {string[]} imageTexts - Fill-gated image pages, oldest first.
 * @param {string[]} rawTexts - Text pages and kept raw texts that stay text.
 * @param {number} frameTokenEstimate - Image-token cost per frame, or 0 when unknown.
 * @param {Record<string, unknown>} settings - Settings carrying the raw text budgets.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Bucket-fitting split.
 */
function applyBucketGate(imageTexts, rawTexts, frameTokenEstimate, settings) {
    if (frameTokenEstimate <= 0) {
        return { imageTexts, rawTexts };
    }
    const bucket = resolveRawChatBucketTokens(settings);
    const images = imageTexts.slice();
    const text = rawTexts.slice();
    while (images.length > 0) {
        const billed = images.length * frameTokenEstimate + estimateRawTextTokens(text);
        if (billed <= bucket) {
            break;
        }
        text.unshift(/** @type {string} */ (images.pop()));
    }
    return { imageTexts: images, rawTexts: text };
}

/**
 * @param {string[]} texts - Text that ships as text.
 * @returns {number} Approximate token count.
 */
function estimateRawTextTokens(texts) {
    return texts.reduce(
        (sum, text) => sum + Math.ceil(String(text ?? '').length / RAW_TEXT_CHARS_PER_TOKEN),
        0,
    );
}

/**
 * @param {number} keepRaw
 * @returns {number} Integer at or above zero.
 */
function normalizeKeepRaw(keepRaw) {
    return Number.isFinite(keepRaw) ? Math.max(0, Math.floor(keepRaw)) : 0;
}
