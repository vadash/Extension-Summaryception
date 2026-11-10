import { OPERATION_MODES, UI_MODES } from '../foundation/constants.js';
import { formatTokenValue } from '../core/token-count.js';

/**
 * @typedef {object} ContextBudgetTokenPart
 * @property {string} label - Display string as shown in the budget card.
 * @property {string} kind - Segment category used for styling and ordering.
 * @property {number} count - Token count for the segment, measured or estimated.
 * @property {boolean} estimated - Whether the count came from fallback estimation.
 */

/**
 * @param {number} tokens
 * @returns {string}
 */
export function getContextColorClass(tokens) {
    if (tokens > 48000) {
        return 'sc-ctx-danger';
    }
    if (tokens > 32000) {
        return 'sc-ctx-caution';
    }
    if (tokens > 24000) {
        return 'sc-ctx-warn';
    }
    return 'sc-ctx-safe';
}

/**
 * @param {{ budget: number, verbatim: ContextBudgetTokenPart, layers: ContextBudgetTokenPart[], wrapper?: ContextBudgetTokenPart | null, marker?: { positionTokens: number, label: string } | null }} input
 * @returns {{ budget: number, used: number, overage: number, denominator: number, totalLabel: string, marker: { percent: number, label: string } | null, segments: Array<ContextBudgetTokenPart & { percent: number, small: boolean }> }}
 */
export function buildContextBudgetViewModel({
    budget,
    verbatim,
    layers,
    wrapper = null,
    marker = null,
}) {
    const normalizedBudget = normalizeBudgetCount(budget);
    const parts = [verbatim, ...layers, wrapper].filter(isVisibleBudgetPart);
    const used = parts.reduce((sum, part) => sum + part.count, 0);
    const overage = Math.max(0, used - normalizedBudget);
    const freeCount = Math.max(0, normalizedBudget - used);
    const anyEstimated = parts.some((part) => part.estimated);
    const markerTokens = marker ? normalizeBudgetCount(marker.positionTokens) : 0;
    const denominator = Math.max(normalizedBudget, used, markerTokens, 1);

    const segments = parts.map((part) => buildBudgetSegment(part, denominator));
    if (freeCount > 0) {
        segments.push(
            buildBudgetSegment(
                { label: 'Free Space', kind: 'free', count: freeCount, estimated: false },
                denominator,
            ),
        );
    }

    return {
        budget: normalizedBudget,
        used,
        overage,
        denominator,
        marker: marker
            ? { percent: Math.min(100, (markerTokens / denominator) * 100), label: marker.label }
            : null,
        totalLabel: `${formatBudgetTokenLabel(used, anyEstimated)} / ${formatBudgetTokenLabel(
            normalizedBudget,
            false,
        )}`,
        segments,
    };
}

/**
 * @param {number} count
 * @param {boolean} estimated
 * @returns {string}
 */
export function formatBudgetTokenLabel(count, estimated = false) {
    return formatTokenValue(normalizeBudgetCount(count), estimated);
}

/**
 * Billed segments for the Recent and Trigger budget bars. Sealed Frozen Pages
 * bill their frame tokens instead of the text they hold, so each bar splits
 * into its surviving text tail plus the image share that covers it, and the
 * View Model colors the share on its own (ADR-0049). A span with no images
 * collapses to the plain text segment.
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @returns {{ recent: { text: ContextBudgetTokenPart, images: ContextBudgetTokenPart }, queued: { text: ContextBudgetTokenPart, images: ContextBudgetTokenPart } }}
 */
export function buildAutoWorkBudgetParts(work) {
    return {
        recent: buildSpanBudgetParts({
            label: 'Recent Chat',
            kind: 'verbatim',
            billedTokens: work?.verbatimTokens,
            imageTokens: work?.verbatimImageTokens,
            estimated: work?.verbatimEstimated,
        }),
        queued: buildSpanBudgetParts({
            label: 'Queued',
            kind: 'pending',
            billedTokens: work?.queuedTokens,
            imageTokens: work?.queuedImageTokens,
            estimated: work?.queuedEstimated,
        }),
    };
}

/**
 * @param {{ label: string, kind: string, billedTokens: number | undefined, imageTokens: number | undefined, estimated: boolean | undefined }} span - Span billing inputs.
 * @returns {{ text: ContextBudgetTokenPart, images: ContextBudgetTokenPart }}
 */
function buildSpanBudgetParts({ label, kind, billedTokens, imageTokens, estimated }) {
    const billed = normalizeBudgetCount(billedTokens ?? 0);
    const images = normalizeBudgetCount(imageTokens ?? 0);
    return {
        text: { label, kind, count: Math.max(0, billed - images), estimated: Boolean(estimated) },
        images: { label: 'Images', kind: 'microfiche', count: images, estimated: false },
    };
}

/**
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @param {ReturnType<import('../foundation/settings.js').getEffectiveSettings>} s
 * @returns {{ queuedTokens: number, queuedEstimated: boolean, triggerTokens: number, label: string }}
 */
export function buildTriggerGaugeModel(work, s) {
    const { text } = buildAutoWorkBudgetParts(work).queued;
    return {
        queuedTokens: text.count,
        queuedEstimated: text.estimated,
        triggerTokens: normalizeBudgetCount(s.queuedTokenBudget),
        label: 'Summarize at Recent + Queued',
    };
}

/**
 * The blocked-step line under the Microfiche bars. A page waits when the sealed
 * raw plan reports `overCap`, which the policy sets when the Fill Gate, the
 * image cap, or the raw bucket leaves a page as text. The binding cap tells the
 * three cases apart: a cap below the configured image cap means the raw bucket
 * shrank it, a full cap with a page waiting means the cap is reached, and a
 * short page list under a full cap means the trailing page missed the 0.75
 * Fill Gate. `memoryNext` drives the red treatment.
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work - Work read model; a not-ready batch keeps the line neutral.
 * @param {{ microficheRaw?: import('../core/microfiche-policy.js').MicroficheRawPlan | null } | null} sealedFacts - Sealed plans from the injection writer.
 * @param {{ microficheImageCap?: number } | null | undefined} [settings] - Effective settings carrying the image cap.
 * @returns {{ text: string, memoryNext: boolean }}
 */
export function buildMicroficheReasonModel(work, sealedFacts, settings = {}) {
    const raw = sealedFacts?.microficheRaw ?? null;
    const images = Array.isArray(raw?.imageTexts) ? raw.imageTexts.length : 0;
    const cap = normalizeBudgetCount(raw?.effectiveCap);
    const sliderCap = normalizeBudgetCount(settings?.microficheImageCap);
    if (raw === null || raw.overCap !== true || work?.ready === false) {
        return {
            text: raw === null ? 'imaging idle' : `imaging ${images}/${cap} images`,
            memoryNext: false,
        };
    }
    if (cap < sliderCap) {
        return { text: 'raw bucket full, memory update next', memoryNext: true };
    }
    if (images >= cap) {
        return {
            text: `at cap ${images}/${cap} images, next page waits, memory update next`,
            memoryNext: true,
        };
    }
    return { text: 'last page under 0.75, memory update next', memoryNext: true };
}

/**
 * Split the assistant turns waiting for summarization into sealed image pages
 * and queued text. The frozen raw region owns the pages that cover the backlog,
 * so its sealed image count caps the image share and the rest stays text.
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work - Work read model carrying the backlog.
 * @param {{ microficheRaw?: import('../core/microfiche-policy.js').MicroficheRawPlan | null } | null} sealedFacts - Sealed plans from the injection writer.
 * @returns {{ backlog: number, images: number, text: number }}
 */
export function buildBacklogSplitModel(work, sealedFacts) {
    const backlog = work?.ready ? normalizeBudgetCount(work.backlog) : 0;
    const raw = sealedFacts?.microficheRaw ?? null;
    const sealedImages = Array.isArray(raw?.imageTexts) ? raw.imageTexts.length : 0;
    const images = Math.min(backlog, normalizeBudgetCount(sealedImages));
    return { backlog, images, text: backlog - images };
}

/**
 * Mode-derived chrome for one settings render: the Off banner, the visible
 * complexity panel, and the controls the Operation Mode gates. The Off banner
 * keeps the remembered panel visible so configuration stays editable while
 * the extension is off.
 * @param {{ mode: string, complexity: string, enabled: boolean }} mode - Operation Mode verdict.
 * @param {{ autoPaused?: boolean }} [options] - Pause Latch state, which only swaps the run controls.
 * @returns {{ modeLabel: string, off: boolean, easyPanel: boolean, advancedPanel: boolean, continuitySection: boolean, stop: boolean, resume: boolean }}
 */
export function buildEnabledContentModel(mode, { autoPaused = false } = {}) {
    const off = mode.mode !== OPERATION_MODES.ON;
    const advanced = mode.complexity === UI_MODES.ADVANCED;
    const paused = Boolean(autoPaused);
    return {
        modeLabel: off ? 'Off' : advanced ? 'Advanced' : 'Easy',
        off,
        easyPanel: !advanced,
        advancedPanel: advanced,
        continuitySection: !off && advanced,
        stop: !off && !paused,
        resume: !off && paused,
    };
}

function buildBudgetSegment(part, denominator) {
    const percent = denominator > 0 ? (part.count / denominator) * 100 : 0;
    return {
        ...part,
        percent,
        small: percent < 8,
    };
}

/**
 * @param {ContextBudgetTokenPart | null | undefined} part
 * @returns {part is ContextBudgetTokenPart}
 */
function isVisibleBudgetPart(part) {
    return Boolean(part && normalizeBudgetCount(part.count) > 0);
}

function normalizeBudgetCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return 0;
    }
    return Math.max(0, Math.ceil(count));
}
