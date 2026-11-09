// Microfiche policy: the one owner of cap reconciliation and the
// oldest-to-images / newest-K-text split. Readers consume the plan, so the
// preview count and the injected split always agree.

import { MICROFICHE_GEOMETRY_PRESETS } from '../foundation/constants.js';
import { buildMicrofichePageTexts, resolveMicroficheShape } from './microfiche-paginate.js';

/**
 * @typedef {object} MicrofichePlan
 * @property {import('./microfiche-paginate.js').MicroficheShape} shape - Resolved render shape.
 * @property {number} keepRaw - Normalized newest-K raw-text count.
 * @property {number} effectiveCap - Images per injection after budget reconciliation.
 * @property {string[]} imageTexts - Capped page texts bound for image frames.
 * @property {string[]} rawTexts - Overflow pages then kept-raw texts, in order.
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
 * One plan every Microfiche reader consumes: shape, cap, split, and the
 * per-frame image-token estimate. Unknown geometry carries no preset budget
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
    const pages = buildMicrofichePageTexts(split.imageTexts, shape, effectiveCap);
    const frameTokenEstimate = Number(presetRecord.frameTokenEstimate);
    return {
        shape,
        keepRaw: normalizeKeepRaw(keepRaw),
        effectiveCap,
        imageTexts: pages.imageTexts,
        rawTexts: [...pages.rawTexts, ...split.rawTexts],
        frameTokenEstimate:
            Number.isFinite(frameTokenEstimate) && frameTokenEstimate > 0 ? frameTokenEstimate : 0,
    };
}

/**
 * @param {number} keepRaw
 * @returns {number} Integer at or above zero.
 */
function normalizeKeepRaw(keepRaw) {
    return Number.isFinite(keepRaw) ? Math.max(0, Math.floor(keepRaw)) : 0;
}
