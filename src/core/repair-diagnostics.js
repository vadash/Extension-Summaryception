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
 * Describe how much text should be removed to reach a soft target.
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
 * @param {string} [options.wrapperTag]
 * @param {string} [options.rejectedSectionTagPrefix]
 * @param {string[]} [options.instructions]
 * @returns {string}
 */
export function formatRepairDiagnostics(
    diagnostics,
    {
        wrapperTag = 'summaryception_repair_feedback',
        rejectedSectionTagPrefix = 'rejected_',
        instructions = [],
    } = {},
) {
    const wrapper = String(wrapperTag);
    const source = diagnostics || {};
    const failing = (source.violations || []).filter(Boolean);
    const passing = (source.sections || []).filter((section) => !section.violation);
    const lines = [
        `<${wrapper}>`,
        `The previous ${source.scope || 'compression'} draft failed output validation.`,
    ];

    appendFailingRepairInstructions(lines, failing);
    appendRejectedSectionBlocks(lines, failing, rejectedSectionTagPrefix);
    appendPassingSectionGuidance(lines, passing);
    appendRejectedDraftFallback(lines, source, failing);
    lines.push(...instructions.filter(Boolean));

    lines.push('</' + wrapper + '>');
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
                    `Your [NARRATIVE] had ${actual} sentences; maximum ${cap}. Merge or drop the ${actual - cap} least-important.`,
                );
            }
        }
    }

    return lines.join('\n');
}

/**
 * @param {string} text
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

function appendRejectedSectionBlocks(lines, failing, prefix) {
    for (const section of failing) {
        const text = section.text.trim();
        if (!text) {
            continue;
        }
        lines.push(`<${prefix}${section.id}>`, text, `</${prefix}${section.id}>`);
    }
}

function appendPassingSectionGuidance(lines, passing) {
    for (const section of passing) {
        const text = section.text.trim();
        if (!text && !section.preservationInstruction) {
            continue;
        }
        lines.push(
            `Preserve ${section.label} unchanged${section.preservationInstruction ? `: ${section.preservationInstruction}` : '.'}`,
        );
        if (text) {
            lines.push(`<preserve_${section.id}>`, text, `</preserve_${section.id}>`);
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
        lines.push('<rejected_draft>', source.rejectedDraft.trim(), '</rejected_draft>');
    }
}
