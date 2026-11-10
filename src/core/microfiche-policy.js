// Microfiche policy: the one owner of cap reconciliation, the Fill Gate, and
// the oldest-to-images / newest-K-text split. Readers consume the plan, so the
// preview count and the injected split always agree.

import { MICROFICHE_GEOMETRY_PRESETS } from '../foundation/constants.js';
import { charCells, frameGrid, usesWideCells } from './microfiche-geometry.js';
import { buildMicrofichePageTexts, resolveMicroficheShape } from './microfiche-paginate.js';
import { resolveRawChatBucketTokens } from './token-budget.js';
import { APPROX_TEXT_UNITS_PER_TOKEN, estimateTextTokens } from './token-count.js';

// A page images only when it fills at least three quarters of its capacity.
// The trailing partial page stays text, because an underfilled frame spends a
// full image cost for little covered text.
const MICROFICHE_FILL_GATE_RATIO = 0.75;

/**
 * The sealed region plan fields memory and raw pages share. Each region keeps
 * its own list so the same page index never crosses regions (ADR-0045).
 * @typedef {object} MicroficheRegionPlan
 * @property {import('./microfiche-geometry.js').MicroficheShape} shape - Resolved render shape.
 * @property {number} effectiveCap - Cap input before the bucket fit; kept images are `imageTexts.length`.
 * @property {string[]} imageTexts - Fill-gated page texts bound for image frames.
 * @property {string[]} rawTexts - Pages that stay text, in order.
 * @property {number} frameTokenEstimate - Image-token estimate per frame, or 0 for custom.
 */

/**
 * The memory region plan: the shared region fields plus the newest-K count.
 * @typedef {MicroficheRegionPlan & { keepRaw: number }} MicrofichePlan
 */

/**
 * The raw-chat region plan: the shared region fields plus the over-cap flag.
 * @typedef {MicroficheRegionPlan & { overCap: boolean }} MicroficheRawPlan
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
    const budgeted = fitImagesToBucket(imageTexts, rawTexts, {
        frameTokenEstimate: estimate,
        bucketTokens: Math.max(0, resolveRawChatBucketTokens(source)),
    });
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
 * Build the frozen-raw plan entry from an oldest-first raw slice. The slice
 * is the Raw Seal (verbatim window + queued span) selected by the writer, so
 * pagination, the Fill Gate, and the bucket gate match the memory region's
 * rules while page indexes stay in their own list. Tail growth is never in
 * this slice: it ships as text until the next Mutation Epoch (ADR-0040).
 * @param {string[]} rawTextsOldestFirst - Frozen raw-chat texts in chronological order.
 * @param {Record<string, unknown>} settings - Settings carrying knobs, cap, preset, and the region toggle.
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @param {MicrofichePlan | null} [memoryPlan] - Memory plan whose images spend the same raw bucket.
 * @returns {MicroficheRawPlan | null} Raw plan, or null when the region is off, empty, or unpaged.
 */
export function buildMicroficheRawPlan(
    rawTextsOldestFirst,
    settings,
    host = null,
    memoryPlan = null,
) {
    const source = settings ?? {};
    if (source.microficheFrozenRawImages !== true) {
        return null;
    }
    const texts = (Array.isArray(rawTextsOldestFirst) ? rawTextsOldestFirst : []).filter(
        (text) => typeof text === 'string' && text.length > 0,
    );
    if (texts.length === 0) {
        return null;
    }
    const shape = resolveMicroficheShape(source);
    const presetRecord = resolveMicrofichePresetRecord(source);
    const baseCap = resolveMicroficheEffectiveCap(
        source.microficheImageCap,
        host !== null && host !== undefined
            ? /** @type {{ imageBudget?: unknown }} */ (host).imageBudget
            : undefined,
        'imageBudget' in presetRecord ? presetRecord.imageBudget : undefined,
    );
    const pages = buildMicrofichePageTexts(texts, shape);
    if (pages.imageTexts.length === 0) {
        return null;
    }
    const filled = applyFillGate(pages.imageTexts, shape);
    const frameTokenEstimate = resolveFrameTokenEstimate(presetRecord);
    const bucketTokens = resolveRawPlanBucketTokens(source, memoryPlan);
    const effectiveCap = Math.min(
        baseCap,
        resolveRawBucketImageCap(bucketTokens, shape, frameTokenEstimate),
    );
    const imageTexts = filled.imageTexts.slice(0, effectiveCap);
    const rawTexts = [...filled.imageTexts.slice(effectiveCap), ...filled.rawTexts];
    const budgeted = fitImagesToBucket(imageTexts, rawTexts, {
        frameTokenEstimate,
        bucketTokens,
    });
    return {
        shape,
        effectiveCap,
        imageTexts: budgeted.imageTexts,
        rawTexts: budgeted.rawTexts,
        frameTokenEstimate,
        // An underfilled trailing page and a bucket demotion both leave a page
        // unimaged, so either one requests the memory update.
        overCap: budgeted.imageTexts.length < pages.imageTexts.length,
    };
}

/**
 * @param {Record<string, unknown>} settings - Settings carrying the geometry name.
 * @returns {Record<string, unknown>} Preset record, or an empty record for custom.
 */
function resolveMicrofichePresetRecord(settings) {
    const name = String(settings.microficheGeometry ?? '');
    const preset = MICROFICHE_GEOMETRY_PRESETS[name] ?? null;
    return /** @type {Record<string, unknown>} */ (preset ?? {});
}

/**
 * @param {Record<string, unknown>} presetRecord - Preset record, possibly empty.
 * @returns {number} Frame token estimate, or 0 when unknown.
 */
function resolveFrameTokenEstimate(presetRecord) {
    const estimate = Number(presetRecord.frameTokenEstimate);
    return Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
}

/**
 * The raw bucket the raw region may spend: the configured raw-chat bucket,
 * less the memory region's image tokens and the memory text that stays raw
 * when that region is toggled on, so both regions debit one figure. The
 * memory plan already charged that text to the same bucket, so leaving it
 * out would let the raw region spend it twice.
 * @param {Record<string, unknown>} settings - Settings carrying toggles and raw budgets.
 * @param {MicrofichePlan | null} memoryPlan - Built memory plan, if any.
 * @returns {number} Bucket tokens available to raw images.
 */
function resolveRawPlanBucketTokens(settings, memoryPlan) {
    const bucket = resolveRawChatBucketTokens(settings);
    if (
        settings.microficheMemoryImages !== true ||
        memoryPlan === null ||
        memoryPlan === undefined
    ) {
        return bucket;
    }
    const memorySpend =
        memoryPlan.imageTexts.length * memoryPlan.frameTokenEstimate +
        estimateRawTextTokens(memoryPlan.rawTexts);
    return Math.max(0, bucket - memorySpend);
}

/**
 * Budget-derived image cap for the raw region: image tokens spend from the raw
 * bucket, but at least one fill-gated page (three quarters of a page's text
 * capacity) stays text, because an underfilled frame spends a full image cost
 * for little coverage. The sixth image in the user's 36k example therefore
 * waits for the next memory update instead of printing.
 * @param {number} bucketTokens - Raw bucket available to this region.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {number} frameTokenEstimate - Image-token cost per frame, or 0 when unknown.
 * @returns {number} Budget cap; Infinity when the frame cost is unknown.
 */
function resolveRawBucketImageCap(bucketTokens, shape, frameTokenEstimate) {
    if (frameTokenEstimate <= 0) {
        return Infinity;
    }
    const geo = frameGrid(shape, shape.frameSize);
    const pageTextTokens = geo.capacity / APPROX_TEXT_UNITS_PER_TOKEN;
    if (!Number.isFinite(pageTextTokens)) {
        return Infinity;
    }
    const fillFloor = pageTextTokens * MICROFICHE_FILL_GATE_RATIO;
    return Math.max(0, Math.floor((bucketTokens - fillFloor) / frameTokenEstimate));
}

/**
 * Bill the minimum over all newest-to-text demotions: keep demoting while the
 * newest page's text costs less than a frame. A page whose text costs at least
 * one frame is never demoted, because demoting it raises the bill and no split
 * can fit; the kept maximum then relies on overCap to trigger a memory update.
 * @param {string[]} imageTexts - Fill-gated image pages, oldest first.
 * @param {string[]} rawTexts - Pages that stay text.
 * @param {{ frameTokenEstimate: number, bucketTokens: number }} budget - Frame cost and bucket size.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Bucket-fitting split.
 */
function fitImagesToBucket(imageTexts, rawTexts, { frameTokenEstimate, bucketTokens }) {
    if (frameTokenEstimate <= 0) {
        return { imageTexts, rawTexts };
    }
    const images = imageTexts.slice();
    const text = rawTexts.slice();
    while (images.length > 0) {
        const billed = images.length * frameTokenEstimate + estimateRawTextTokens(text);
        if (billed <= bucketTokens) {
            break;
        }
        const newest = /** @type {string} */ (images[images.length - 1]);
        if (estimateTextTokens(newest) >= frameTokenEstimate) {
            break;
        }
        text.unshift(/** @type {string} */ (images.pop()));
    }
    return { imageTexts: images, rawTexts: text };
}

/**
 * Gate the trailing partial page only. Earlier pages image even when a
 * sentence break leaves them under the ratio, because more content follows
 * them; only the final page can be the growing remainder. Pagination fills
 * pages in order, so no other page is partial.
 * @param {string[]} pages - Page strings in order.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Gated images plus the trailing text page.
 */
function applyFillGate(pages, shape) {
    if (pages.length === 0) {
        return { imageTexts: [], rawTexts: [] };
    }
    const last = /** @type {string} */ (pages[pages.length - 1]);
    const geo = frameGrid(shape, shape.frameSize);
    if (pageFillRatio(last, shape, geo) >= MICROFICHE_FILL_GATE_RATIO) {
        return { imageTexts: pages.slice(), rawTexts: [] };
    }
    return { imageTexts: pages.slice(0, -1), rawTexts: [last] };
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
 * @param {string[]} texts - Text that ships as text.
 * @returns {number} Approximate token count.
 */
function estimateRawTextTokens(texts) {
    return texts.reduce((sum, text) => sum + estimateTextTokens(text), 0);
}

/**
 * @param {number} keepRaw
 * @returns {number} Integer at or above zero.
 */
function normalizeKeepRaw(keepRaw) {
    return Number.isFinite(keepRaw) ? Math.max(0, Math.floor(keepRaw)) : 0;
}
