import {
    computeNarrativeSentenceCap,
    computeStateLineCap,
} from './structural-constraints.js';

/**
 * Given a size-rejection diagnostics object, produce a structural feedback
 * line to append to the existing token repair feedback. The line tells the
 * model how many lines/sentences it produced versus the source-derived cap,
 * so it has a countable signal alongside the token diagnostics.
 * @param {object} diagnostics - From `buildRepairDiagnostics` (repair-diagnostics.js).
 * @param {{ sourceStateKeyCount?: number, sourceNarrativeTokens?: number }} sourceBudget
 * @returns {string} Extra structural lines ('' when nothing actionable).
 */
export function buildStructuralRepairFeedback(diagnostics = {}, sourceBudget = {}) {
    const violations = Array.isArray(diagnostics.violations) ? diagnostics.violations : [];
    const lines = [];

    for (const violation of violations) {
        if (!violation || violation.reason !== 'above-hard-maximum') {
            continue;
        }
        const text = String(violation.text || '');

        if (violation.id === 'state') {
            const actual = countStateLines(text);
            const cap = computeStateLineCap(sourceBudget.sourceStateKeyCount);
            if (actual > cap) {
                lines.push(
                    `Your [STATE] had ${actual} lines; maximum ${cap}. Remove the ${actual - cap} least-durable keys.`,
                );
            }
        } else if (violation.id === 'narrative') {
            const actual = countSentences(text);
            const cap = computeNarrativeSentenceCap(sourceBudget.sourceNarrativeTokens);
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
 * Count non-empty `key: value` lines in a state body.
 * @param {string} text
 * @returns {number}
 */
function countStateLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && /.+:.+/.test(line))
        .length;
}

/**
 * Count sentences in a narrative passage.
 * @param {string} text
 * @returns {number}
 */
function countSentences(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        return 0;
    }
    // Split on terminal punctuation followed by whitespace; a trailing
    // sentence with no following space still counts via the filter length.
    const parts = trimmed.split(/[.!?]+\s+/).filter(Boolean);
    return parts.length;
}
