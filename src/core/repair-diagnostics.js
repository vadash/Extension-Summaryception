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
 * Build pure, structured diagnostics for a rejected compression draft.
 * @param {object} p
 * @param {string} [p.scope] - Prompt family or output contract name
 * @param {number} p.totalTokens - Total draft tokens, for diagnostics only
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
    const normalizedSections = sections.map((section) => {
        const actualTokens = normalizeCount(section.actualTokens);
        const targetTokens = normalizeCount(section.targetTokens);
        const hardMaxTokens = normalizeCount(section.hardMaxTokens);
        const minimumTokens = normalizeCount(section.minimumTokens);
        const tooShort = minimumTokens > 0 && actualTokens < minimumTokens;
        const tooLong = hardMaxTokens > 0 && actualTokens > hardMaxTokens;
        const violation = tooShort || tooLong;
        return {
            id: String(section.id || section.name || 'section'),
            label: String(section.label || section.id || section.name || 'Section'),
            actualTokens,
            targetTokens,
            hardMaxTokens,
            minimumTokens,
            violation,
            reason: tooShort ? 'below-minimum' : tooLong ? 'above-hard-maximum' : '',
            reductionGuidance:
                tooLong && targetTokens > 0 ? getReductionGuidance(actualTokens, targetTokens) : '',
            text: String(section.text || ''),
            repairInstruction: String(section.repairInstruction || ''),
            preservationInstruction: String(section.preservationInstruction || ''),
        };
    });

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
 * @returns {string}
 */
export function formatRepairDiagnostics(
    diagnostics,
    { wrapperTag = 'summaryception_repair_feedback', rejectedSectionTagPrefix = 'rejected_' } = {},
) {
    const wrapper = String(wrapperTag);
    const failing = (diagnostics?.violations || []).filter(Boolean);
    const passing = (diagnostics?.sections || []).filter((section) => !section.violation);
    const lines = [
        `<${wrapper}>`,
        `The previous ${diagnostics?.scope || 'compression'} draft failed output validation.`,
    ];

    for (const section of failing) {
        const target = section.targetTokens > 0 ? `; target ${section.targetTokens}` : '';
        const minimum = section.minimumTokens > 0 ? `; minimum ${section.minimumTokens}` : '';
        const hardMax = section.hardMaxTokens > 0 ? `; hard maximum ${section.hardMaxTokens}` : '';
        const guidance = section.reductionGuidance
            ? `; reduce by ${section.reductionGuidance}`
            : '';
        lines.push(
            `${section.label}: ${section.actualTokens} tokens${target}${minimum}${hardMax}${guidance}.`,
        );
        if (section.repairInstruction) {
            lines.push(`${section.label} repair: ${section.repairInstruction}`);
        }
    }

    lines.push(`Total draft: ${diagnostics?.totalTokens || 0} tokens (diagnostic only).`);

    for (const section of failing) {
        const text = section.text.trim();
        if (!text) {
            continue;
        }
        lines.push(
            `<${rejectedSectionTagPrefix}${section.id}>`,
            text,
            `</${rejectedSectionTagPrefix}${section.id}>`,
        );
    }

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

    if (diagnostics?.rejectedDraft && failing.length === 0) {
        lines.push('<rejected_draft>', diagnostics.rejectedDraft.trim(), '</rejected_draft>');
    }

    lines.push('</' + wrapper + '>');
    return lines.join('\n');
}

function normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}
