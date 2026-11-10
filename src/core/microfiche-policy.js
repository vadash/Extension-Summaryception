// Microfiche policy: the one owner of cap reconciliation, oldest-first
// pagination, and the raw region's whole-message keep-text tail. Readers consume
// the plan, so the preview count and the injected split always agree.

import { MICROFICHE_GEOMETRY_PRESETS } from '../foundation/constants.js';
import { buildMicrofichePageTexts, resolveMicroficheShape } from './microfiche-paginate.js';
import { resolveRawChatBucketTokens } from './token-budget.js';
import { estimateTextTokens } from './token-count.js';

/**
 * The sealed region plan fields memory and raw pages share. Each region keeps
 * its own list so the same page index never crosses regions (ADR-0045).
 * @typedef {object} MicroficheRegionPlan
 * @property {import('./microfiche-geometry.js').MicroficheShape} shape - Resolved render shape.
 * @property {number} effectiveCap - Cap input before the bucket fit; kept images are `imageTexts.length`.
 * @property {string[]} imageTexts - Page texts bound for image frames.
 * @property {string[]} rawTexts - Page and whole-message texts that stay text, oldest first.
 * @property {number} frameTokenEstimate - Image-token estimate per frame, or 0 for custom.
 */

/**
 * The memory region plan: the shared region fields.
 * @typedef {MicroficheRegionPlan} MicrofichePlan
 */

/**
 * The raw-chat region plan: the shared region fields plus the over-cap flag and
 * the page-overflow count. The count excludes the Keep Raw whole-message tail,
 * so a slots-full reason reports pages that wait, not chat that stays text.
 * @typedef {MicroficheRegionPlan & { overCap: boolean, overflowPages: number }} MicroficheRawPlan
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
 * Split oldest-first raw chat texts: the oldest paginate to images, the newest
 * K stay whole as raw text. keepRaw 0 means all-to-images; keepRaw past the
 * input length keeps every message raw.
 * @param {string[]} textsOldestFirst - Raw chat message texts in chronological order.
 * @param {number} keepRaw - Newest whole messages kept as raw text.
 * @returns {{ imageTexts: string[], rawTexts: string[] }} Image-bound and raw text lists.
 */
export function splitMicroficheTexts(textsOldestFirst, keepRaw) {
    const texts = Array.isArray(textsOldestFirst) ? textsOldestFirst : [];
    const count = normalizeKeepRaw(keepRaw);
    const boundary = Math.max(0, texts.length - count);
    return { imageTexts: texts.slice(0, boundary), rawTexts: texts.slice(boundary) };
}

/**
 * One plan every Microfiche reader consumes: shape, cap, pagination, and the
 * per-frame image-token estimate. Every snippet text paginates to an image
 * page; the cap and the raw bucket decide how many ship. Unknown geometry
 * carries no preset budget and no frame estimate, so custom stays fully
 * slider/host driven.
 * @param {string[]} textsOldestFirst - Snippet texts in chronological order.
 * @param {Record<string, unknown>} settings - Settings carrying knobs, slider cap, and preset name.
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @returns {MicrofichePlan} Built plan.
 */
export function buildMicrofichePlan(textsOldestFirst, settings, host = null) {
    const source = settings ?? {};
    const shape = resolveMicroficheShape(source);
    const presetRecord = resolveMicrofichePresetRecord(source);
    const effectiveCap = resolveMicroficheEffectiveCap(
        source.microficheImageCap,
        host !== null && host !== undefined
            ? /** @type {{ imageBudget?: unknown }} */ (host).imageBudget
            : undefined,
        'imageBudget' in presetRecord ? presetRecord.imageBudget : undefined,
    );
    const texts = (Array.isArray(textsOldestFirst) ? textsOldestFirst : []).filter(
        (text) => typeof text === 'string',
    );
    const pages = buildMicrofichePageTexts(texts, shape);
    const imageTexts = pages.imageTexts.slice(0, effectiveCap);
    const rawTexts = pages.imageTexts.slice(effectiveCap);
    const frameTokenEstimate = resolveFrameTokenEstimate(presetRecord);
    const budgeted = fitImagesToBucket(imageTexts, rawTexts, {
        frameTokenEstimate,
        bucketTokens: Math.max(0, resolveRawChatBucketTokens(source)),
    });
    return {
        shape,
        effectiveCap,
        imageTexts: budgeted.imageTexts,
        rawTexts: budgeted.rawTexts,
        frameTokenEstimate,
    };
}

/**
 * Build the frozen-raw plan entry from an oldest-first raw slice. The slice is
 * the Raw Seal (verbatim window + queued span) selected by the writer. The
 * newest `microficheKeepRaw` messages stay whole text before pagination, so
 * the tail slides each generation while older messages image. Pagination and
 * the bucket gate match the memory region's rules while page indexes stay in
 * their own list. Tail growth is never in this slice: it ships as text until
 * the next Mutation Epoch (ADR-0040).
 * @param {string[]} rawTextsOldestFirst - Frozen raw-chat texts in chronological order.
 * @param {Record<string, unknown>} settings - Settings carrying knobs, cap, preset, keep count, and the region toggle.
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @param {MicrofichePlan | null} [memoryPlan] - Memory plan whose images spend the same raw bucket.
 * @returns {MicroficheRawPlan | null} Raw plan, or null when the region is off or has no raw text.
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
    const { imageTexts: paginatedTexts, rawTexts: keptTail } = splitMicroficheTexts(
        texts,
        Number(source.microficheKeepRaw),
    );
    const pages = buildMicrofichePageTexts(paginatedTexts, shape);
    const frameTokenEstimate = resolveFrameTokenEstimate(presetRecord);
    const bucketTokens = resolveRawPlanBucketTokens(source, memoryPlan);
    const effectiveCap = Math.min(
        baseCap,
        resolveRawBucketImageCap(bucketTokens, frameTokenEstimate),
    );
    const imageTexts = pages.imageTexts.slice(0, effectiveCap);
    const rawTexts = [...pages.imageTexts.slice(effectiveCap), ...keptTail];
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
        // The cap or the bucket can leave a page unimaged, and either case
        // requests the memory update.
        overCap: budgeted.imageTexts.length < pages.imageTexts.length,
        overflowPages: pages.imageTexts.length - budgeted.imageTexts.length,
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
 * less the memory region's image tokens and the overflow page text it keeps
 * raw, so both regions debit one figure. Microfiche always images memory, so a
 * memory plan always debits this bucket. The memory plan already charged that
 * text to the same bucket, so leaving it out would let the raw region spend it
 * twice.
 * @param {Record<string, unknown>} settings - Settings carrying raw budgets.
 * @param {MicrofichePlan | null} memoryPlan - Built memory plan, if any.
 * @returns {number} Bucket tokens available to raw images.
 */
function resolveRawPlanBucketTokens(settings, memoryPlan) {
    const bucket = resolveRawChatBucketTokens(settings);
    if (memoryPlan === null || memoryPlan === undefined) {
        return bucket;
    }
    const memorySpend =
        memoryPlan.imageTexts.length * memoryPlan.frameTokenEstimate +
        estimateRawTextTokens(memoryPlan.rawTexts);
    return Math.max(0, bucket - memorySpend);
}

/**
 * Budget-derived image cap for the raw region: each image bills one frame from
 * the raw bucket, so the bucket holds floor(bucket / frameCost) frames.
 * @param {number} bucketTokens - Raw bucket available to this region.
 * @param {number} frameTokenEstimate - Image-token cost per frame, or 0 when unknown.
 * @returns {number} Budget cap; Infinity when the frame cost is unknown.
 */
function resolveRawBucketImageCap(bucketTokens, frameTokenEstimate) {
    if (frameTokenEstimate <= 0) {
        return Infinity;
    }
    return Math.max(0, Math.floor(bucketTokens / frameTokenEstimate));
}

/**
 * Bill the minimum over all newest-to-text demotions: keep demoting while the
 * newest page's text costs less than a frame. A page whose text costs at least
 * one frame is never demoted, because demoting it raises the bill and no split
 * can fit; the kept maximum then relies on overCap to trigger a memory update.
 * @param {string[]} imageTexts - Image pages, oldest first.
 * @param {string[]} rawTexts - Page and whole-message texts that stay text.
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
