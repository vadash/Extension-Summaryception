import { computeSentenceCap } from './token-budget.js';

const REDUCTION_GUIDANCE = [
    { amount: 0.8, label: 'about four-fifths' },
    { amount: 0.75, label: 'about three-quarters' },
    { amount: 2 / 3, label: 'about two-thirds' },
    { amount: 0.6, label: 'about three-fifths' },
    { amount: 0.5, label: 'about half' },
    { amount: 0.4, label: 'about two-fifths' },
    { amount: 1 / 3, label: 'about one-third' },
    { amount: 0.25, label: 'about one-quarter' },
    { amount: 0.2, label: 'about one-fifth' },
];

/**
 * @param {object} p
 * @param {string} [p.scope] - Prompt family or output contract name
 * @param {number} [p.totalTokens] - Total draft tokens, for diagnostics only
 * @param {Array<object>} p.sections - Section size specifications
 * @param {string} [p.rejectedDraft] - Full rejected draft text
 * @returns {object}
 */
export function buildRepairDiagnostics({
    scope = 'compression',
    totalTokens = 0,
    sections = [],
    rejectedDraft = '',
}) {
    const normalizedSections = sections.map(normalizeRepairSection);

    return {
        scope: String(scope),
        totalTokens: normalizeCount(totalTokens),
        sections: normalizedSections,
        violations: normalizedSections.filter((section) => section.violation),
        rejectedDraft: String(rejectedDraft || ''),
    };
}

/**
 * @param {number} actualTokens
 * @param {number} targetTokens
 * @returns {string}
 */
export function getReductionGuidance(actualTokens, targetTokens) {
    const actual = normalizeCount(actualTokens);
    const target = normalizeCount(targetTokens);
    if (actual <= 0 || target <= 0 || actual <= target) {
        return 'no reduction needed';
    }

    const reduction = 1 - target / actual;
    const closest = REDUCTION_GUIDANCE.reduce((best, candidate) =>
        Math.abs(candidate.amount - reduction) < Math.abs(best.amount - reduction)
            ? candidate
            : best,
    );
    return closest.label;
}

/**
 * Render diagnostics for a prompt adapter while keeping the data contract shared.
 * @param {object} diagnostics
 * @param {object} [options]
 * @param {string[]} [options.instructions]
 * @returns {string}
 */
export function formatRepairDiagnostics(diagnostics, { instructions = [] } = {}) {
    const source = diagnostics || {};
    const failing = (source.violations || []).filter(Boolean);
    const passing = (source.sections || []).filter((section) => !section.violation);
    const lines = [
        '<feedback>',
        `previous ${source.scope || 'compression'} draft: failed output validation.`,
    ];

    appendFailingRepairInstructions(lines, failing);
    appendRejectedSectionBlocks(lines, failing);
    appendPassingSectionGuidance(lines, passing);
    appendRejectedDraftFallback(lines, source, failing);
    lines.push(...instructions.filter(Boolean));

    lines.push('</feedback>');
    return lines.join('\n');
}
/**
 * Build countable repair feedback for output above a hard maximum.
 * @param {object} diagnostics
 * @param {{ targetTokens?: number, layer?: 'l0' | 'l1' | 'l2' }} [sourceBudget]
 * @returns {string}
 */
export function buildStructuralRepairFeedback(diagnostics = {}, sourceBudget = {}) {
    const violations = Array.isArray(diagnostics.violations) ? diagnostics.violations : [];
    const lines = [];

    for (const violation of violations) {
        if (!violation || violation.reason !== 'above-hard-maximum') {
            continue;
        }
        const text = String(violation.text || '');
        if (violation.id === 'narrative') {
            const actual = countSentences(text);
            const cap = computeSentenceCap(sourceBudget.layer ?? 'l0', sourceBudget.targetTokens);
            if (actual > cap) {
                lines.push(
                    `narrative: ${actual} sentences, maximum ${cap}. cut: ${actual - cap} of the least important, merged or dropped.`,
                );
            }
        }
    }

    return lines.join('\n');
}

/** Floor for the Layer 0 retry sentence cap: retries tighten but never below this. */
export const LAYER0_RETRY_CAP_FLOOR = 5;

/**
 * Resolve the Layer 0 retry sentence cap for a zero-based attempt index.
 * Pure; the caller derives baseCap from the frozen Call Profile.
 * @param {number} baseCap - Sentence cap for the first attempt
 * @param {number} attempt - Zero-based attempt index
 * @returns {number}
 */
export function resolveLayer0RetryCap(baseCap, attempt) {
    const base = Number.isFinite(baseCap) ? Math.trunc(baseCap) : LAYER0_RETRY_CAP_FLOOR;
    const step = Number.isFinite(attempt) ? Math.trunc(attempt) : 0;
    return Math.max(LAYER0_RETRY_CAP_FLOOR, base - step);
}

/**
 * Build one Layer 0 retry tightening line for the recall above its limits.
 * Pure; no settings reads. Empty when the attempt needs no tightening.
 * @param {object} p
 * @param {number} p.attempt - Zero-based attempt index
 * @param {number | null} [p.baseCap] - Sentence cap for the first attempt; null when not an L0 size-guard call
 * @param {string} p.rejectedDraft - Last rejected draft text
 * @returns {string}
 */
export function buildLayer0RetryTighteningLine({ attempt, baseCap, rejectedDraft }) {
    if (!Number.isFinite(attempt) || attempt < 1) {
        return '';
    }
    if (!Number.isFinite(baseCap)) {
        return '';
    }
    const base = /** @type {number} */ (baseCap);
    const rejected = countSentences(rejectedDraft);
    if (!rejected) {
        return '';
    }
    const newCap = resolveLayer0RetryCap(base, attempt);
    const cut = Math.max(1, rejected - newCap);
    return (
        `tighten: attempt ${Math.trunc(attempt)}, prior caps superseded, ` +
        `write at most ${newCap} sentences; ${rejected}-sentence draft -> ${newCap}-sentence rewrite, ` +
        `cut at least ${cut} weakest beats whole, survivor wording kept.`
    );
}
/**
 * Derive the Layer 0 retry base cap from the frozen Call Profile only.
 * Null when the call is not a Layer 0 compression call: no sizeGuard,
 * or promotion constraints. Pure; never reads settings.
 * @param {import('./call-profile.js').CallProfile} [profile] - Call profile resolved at dispatch
 * @returns {number | null}
 */
export function resolveL0RetryBaseCap(profile) {
    const policy = profile?.policy;
    if (!policy || !policy.sizeGuard || policy.promotionConstraints) {
        return null;
    }
    return computeSentenceCap('l0', policy.sizeGuard.target);
}

/**
 * @returns {number}
 */
export function countSentences(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/[.!?]+\s+/).filter(Boolean).length : 0;
}

function normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function normalizeRepairSection(section) {
    const actualTokens = normalizeCount(section.actualTokens);
    const targetTokens = normalizeCount(section.targetTokens);
    const hardMaxTokens = normalizeCount(section.hardMaxTokens);
    const minimumTokens = normalizeCount(section.minimumTokens);
    const tooShort = minimumTokens > 0 && actualTokens < minimumTokens;
    const tooLong = hardMaxTokens > 0 && actualTokens > hardMaxTokens;
    // Callers with no token contract (e.g. section-level verdicts) reject a
    // section explicitly instead of through bounds.
    const explicitlyRejected = section.violation === true;
    const violation = tooShort || tooLong || explicitlyRejected;
    return {
        ...resolveSectionIdentity(section),
        actualTokens,
        targetTokens,
        hardMaxTokens,
        minimumTokens,
        violation,
        reason: tooShort
            ? 'below-minimum'
            : tooLong
              ? 'above-hard-maximum'
              : explicitlyRejected
                ? 'section-rejected'
                : '',
        reductionGuidance:
            tooLong && targetTokens > 0 ? getReductionGuidance(actualTokens, targetTokens) : '',
        text: String(section.text || ''),
        repairInstruction: String(section.repairInstruction || ''),
        preservationInstruction: String(section.preservationInstruction || ''),
    };
}

function appendFailingRepairInstructions(lines, failing) {
    for (const section of failing) {
        lines.push(`${section.label}: rejected.`);
        if (section.repairInstruction) {
            lines.push(`${section.label} repair: ${section.repairInstruction}`);
        }
    }
}

function appendRejectedSectionBlocks(lines, failing) {
    for (const section of failing) {
        const text = section.text.trim();
        if (!text) {
            continue;
        }
        lines.push('<rejected>', text, '</rejected>');
    }
}

function appendPassingSectionGuidance(lines, passing) {
    for (const section of passing) {
        const text = section.text.trim();
        if (!text && !section.preservationInstruction) {
            continue;
        }
        lines.push(
            `preserve: ${section.label} unchanged${section.preservationInstruction ? `, ${section.preservationInstruction}` : '.'}`,
        );
        if (text) {
            // Reference text handed back as input, so the retry can reproduce it.
            lines.push('<in>', text, '</in>');
        }
    }
}

function resolveSectionIdentity(section) {
    return {
        id: String(section.id || section.name || 'section'),
        label: String(section.label || section.id || section.name || 'Section'),
    };
}

function appendRejectedDraftFallback(lines, source, failing) {
    if (source.rejectedDraft && failing.length === 0) {
        lines.push('<rejected>', source.rejectedDraft.trim(), '</rejected>');
    }
}
