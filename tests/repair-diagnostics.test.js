import { describe, expect, it } from 'vitest';

import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    countSentences,
    formatRepairDiagnostics,
    getReductionGuidance,
} from '../src/core/repair-diagnostics.js';
import { computeSentenceCap } from '../src/core/token-budget.js';

describe('buildRepairDiagnostics', () => {
    it('coerces non-finite section counts to 0 and rounds positive ones', () => {
        const { sections } = buildRepairDiagnostics({
            sections: [
                { id: 'a', actualTokens: 'abc', targetTokens: NaN },
                { id: 'b', actualTokens: 10.6 },
            ],
        });
        expect(sections[0].actualTokens).toBe(0);
        expect(sections[0].targetTokens).toBe(0);
        expect(sections[1].actualTokens).toBe(11);
    });

    it('flags below-minimum only when minimumTokens > 0 and actual is under it', () => {
        const { sections } = buildRepairDiagnostics({
            sections: [
                { id: 'short', actualTokens: 5, minimumTokens: 10 },
                // minimumTokens: 0 must never trigger below-minimum.
                { id: 'zeromin', actualTokens: 0, minimumTokens: 0 },
            ],
        });
        expect(sections[0]).toMatchObject({ violation: true, reason: 'below-minimum' });
        expect(sections[1]).toMatchObject({ violation: false, reason: '' });
    });

    it('flags above-hard-maximum only when hardMaxTokens > 0 and actual exceeds it', () => {
        const { sections } = buildRepairDiagnostics({
            sections: [
                { id: 'long', actualTokens: 20, hardMaxTokens: 10 },
                { id: 'ok', actualTokens: 20, hardMaxTokens: 0 },
            ],
        });
        expect(sections[0]).toMatchObject({ violation: true, reason: 'above-hard-maximum' });
        expect(sections[1]).toMatchObject({ violation: false, reason: '' });
    });

    it('collects only violating sections into violations while sections keeps all', () => {
        const diagnostics = buildRepairDiagnostics({
            sections: [
                { id: 'short', actualTokens: 5, minimumTokens: 10 },
                { id: 'long', actualTokens: 20, hardMaxTokens: 10 },
                { id: 'clean', actualTokens: 8, minimumTokens: 4, hardMaxTokens: 40 },
            ],
        });
        expect(diagnostics.sections).toHaveLength(3);
        expect(diagnostics.violations.map((s) => s.id)).toEqual(['short', 'long']);
    });

    it('honors an explicit violation flag for sections with no token bounds', () => {
        const diagnostics = buildRepairDiagnostics({
            scope: 'auditor',
            sections: [
                {
                    id: 'parse',
                    label: 'JSON object',
                    violation: true,
                    repairInstruction: 'emit JSON only.',
                },
                { id: 'clean', label: 'clean' },
            ],
        });
        expect(diagnostics.violations.map((s) => s.id)).toEqual(['parse']);
        const output = formatRepairDiagnostics(diagnostics);
        expect(output).toContain('JSON object: rejected.');
        expect(output).toContain('JSON object repair: emit JSON only.');
        expect(output).not.toContain('<rejected_parse>');
    });

    it('defaults id from id -> name -> "section" and label from label -> id -> name -> "Section"', () => {
        const { sections } = buildRepairDiagnostics({
            sections: [
                { name: 'fromName' },
                {},
                { id: 'onlyId' },
                { label: 'Nice Label', name: 'fromName' },
            ],
        });
        expect(sections[0]).toMatchObject({ id: 'fromName', label: 'fromName' });
        expect(sections[1]).toMatchObject({ id: 'section', label: 'Section' });
        expect(sections[2]).toMatchObject({ id: 'onlyId', label: 'onlyId' });
        expect(sections[3]).toMatchObject({ id: 'fromName', label: 'Nice Label' });
    });

    it('populates reductionGuidance only when tooLong and targetTokens > 0', () => {
        const { sections } = buildRepairDiagnostics({
            sections: [
                // tooLong with a positive target -> guidance populated.
                { id: 'long', actualTokens: 200, targetTokens: 100, hardMaxTokens: 150 },
                // tooLong but no target -> empty guidance.
                { id: 'longNoTarget', actualTokens: 200, targetTokens: 0, hardMaxTokens: 150 },
                // not tooLong -> empty guidance.
                { id: 'ok', actualTokens: 50, targetTokens: 100, hardMaxTokens: 150 },
            ],
        });
        expect(sections[0].reductionGuidance).not.toBe('');
        expect(sections[1].reductionGuidance).toBe('');
        expect(sections[2].reductionGuidance).toBe('');
    });

    it('string-coerces scope and rejectedDraft (defaulting rejectedDraft to "") and normalizes totalTokens', () => {
        const withDefaults = buildRepairDiagnostics({ sections: [] });
        expect(withDefaults.scope).toBe('compression');
        expect(withDefaults.rejectedDraft).toBe('');
        expect(withDefaults.totalTokens).toBe(0);

        const coerced = buildRepairDiagnostics({
            scope: 42,
            rejectedDraft: 7,
            totalTokens: 10.4,
            sections: [],
        });
        expect(coerced.scope).toBe('42');
        expect(coerced.rejectedDraft).toBe('7');
        expect(coerced.totalTokens).toBe(10);
    });
});

describe('getReductionGuidance', () => {
    it.each([
        ['non-finite actual', NaN, 100],
        ['non-finite target', 100, NaN],
        ['empty actual', '', 100],
        ['actual <= 0', 0, 100],
        ['target <= 0', 100, 0],
        ['actual <= target', 100, 100],
        ['actual under target', 50, 100],
    ])('returns the no-op sentinel for %s', (_label, actual, target) => {
        expect(getReductionGuidance(actual, target)).toBe('no reduction needed');
    });

    it('returns a non-empty non-sentinel label whenever actual exceeds target', () => {
        const barelyOver = getReductionGuidance(101, 100);
        const heavilyOver = getReductionGuidance(1000, 100);
        for (const result of [barelyOver, heavilyOver]) {
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
            expect(result).not.toBe('no reduction needed');
        }
    });
});

describe('formatRepairDiagnostics', () => {
    it('wraps the body in the default wrapper tag and references the scope', () => {
        const diagnostics = buildRepairDiagnostics({ scope: 'Layer 0', sections: [] });
        const output = formatRepairDiagnostics(diagnostics);
        expect(output.startsWith('<summaryception_repair_feedback>')).toBe(true);
        expect(output.trimEnd().endsWith('</summaryception_repair_feedback>')).toBe(true);
        expect(output).toContain('Layer 0');
    });

    it('honors a custom wrapperTag', () => {
        const diagnostics = buildRepairDiagnostics({ sections: [] });
        const output = formatRepairDiagnostics(diagnostics, { wrapperTag: 'custom_tag' });
        expect(output).toContain('<custom_tag>');
        expect(output).toContain('</custom_tag>');
    });

    it('appends instructions inside the wrapper before closing it', () => {
        const diagnostics = buildRepairDiagnostics({ sections: [] });
        const output = formatRepairDiagnostics(diagnostics, {
            instructions: ['Rewrite only rejected sections.'],
        });
        expect(output).toContain(
            'Rewrite only rejected sections.\n</summaryception_repair_feedback>',
        );
    });

    it('emits rejected blocks and repair instructions for failing sections, skipping empty text', () => {
        const diagnostics = buildRepairDiagnostics({
            sections: [
                {
                    id: 'long',
                    label: '[NARRATIVE]',
                    actualTokens: 200,
                    hardMaxTokens: 100,
                    text: 'too much prose',
                    repairInstruction: 'cut it down',
                },
                // Violating but empty text -> no rejected block for it.
                { id: 'empty', actualTokens: 200, hardMaxTokens: 100, text: '   ' },
            ],
        });
        const output = formatRepairDiagnostics(diagnostics);
        expect(output).toContain('<rejected_long>');
        expect(output).toContain('too much prose');
        expect(output).toContain('</rejected_long>');
        expect(output).toContain('[NARRATIVE] repair: cut it down');
        expect(output).not.toContain('<rejected_empty>');
    });

    it('honors a custom rejectedSectionTagPrefix', () => {
        const diagnostics = buildRepairDiagnostics({
            sections: [{ id: 'long', actualTokens: 200, hardMaxTokens: 100, text: 'body' }],
        });
        const output = formatRepairDiagnostics(diagnostics, {
            rejectedSectionTagPrefix: 'bad_',
        });
        expect(output).toContain('<bad_long>');
        expect(output).toContain('</bad_long>');
    });

    it('emits preserve directives and blocks for passing sections with text or a preservation instruction', () => {
        const diagnostics = buildRepairDiagnostics({
            sections: [
                { id: 'keep', label: '[NARRATIVE]', actualTokens: 10, text: 'keep me' },
                {
                    id: 'note',
                    label: 'Note',
                    actualTokens: 10,
                    preservationInstruction: 'verbatim',
                },
            ],
        });
        const output = formatRepairDiagnostics(diagnostics);
        expect(output).toContain('Preserve [NARRATIVE] unchanged');
        expect(output).toContain('<preserve_keep>');
        expect(output).toContain('keep me');
        expect(output).toContain('Preserve Note unchanged: verbatim');
    });

    it('emits the rejected_draft block only when rejectedDraft is truthy and there are no violations', () => {
        const clean = buildRepairDiagnostics({
            rejectedDraft: 'whole draft',
            sections: [{ id: 'ok', actualTokens: 10 }],
        });
        expect(formatRepairDiagnostics(clean)).toContain('<rejected_draft>');

        const withViolation = buildRepairDiagnostics({
            rejectedDraft: 'whole draft',
            sections: [{ id: 'long', actualTokens: 200, hardMaxTokens: 100 }],
        });
        expect(formatRepairDiagnostics(withViolation)).not.toContain('<rejected_draft>');
    });
});

describe('countSentences', () => {
    it.each([
        ['', 0],
        ['   ', 0],
        [null, 0],
    ])('returns 0 for empty input (%s)', (text, expected) => {
        expect(countSentences(text)).toBe(expected);
    });

    it('counts a single unterminated sentence as 1', () => {
        expect(countSentences('a lone fragment with no terminal mark')).toBe(1);
    });

    it('splits on terminal punctuation followed by whitespace', () => {
        expect(countSentences('One. Two! Three?')).toBe(3);
    });

    it('counts a trailing sentence with no following whitespace', () => {
        expect(countSentences('One. Two')).toBe(2);
    });
});

// Build a size-rejection diagnostics object via the shared contract so the
// feedback tests track buildRepairDiagnostics rather than hand-crafted shapes.
function makeViolation({ id, text, reason = 'above-hard-maximum' }) {
    const hardMaxTokens = reason === 'above-hard-maximum' ? 1 : 0;
    const minimumTokens = reason === 'below-minimum' ? 100 : 0;
    return buildRepairDiagnostics({
        sections: [
            {
                id,
                actualTokens: reason === 'below-minimum' ? 1 : 100,
                hardMaxTokens,
                minimumTokens,
                text,
            },
        ],
    });
}

describe('buildStructuralRepairFeedback', () => {
    it('returns "" when violations is missing or not an array', () => {
        expect(buildStructuralRepairFeedback({}, {})).toBe('');
        expect(buildStructuralRepairFeedback({ violations: 'nope' }, {})).toBe('');
    });

    it('returns "" when the only violation is below-minimum (not above-hard-maximum)', () => {
        const diagnostics = makeViolation({
            id: 'narrative',
            text: 'a short beat',
            reason: 'below-minimum',
        });
        expect(buildStructuralRepairFeedback(diagnostics, {})).toBe('');
    });

    it('emits a narrative line mentioning sentences and the cap when the count exceeds it', () => {
        const sourceBudget = { layer: 'l0', targetTokens: 100 };
        const cap = computeSentenceCap('l0', 100);
        const sentences = Array.from({ length: cap + 3 }, (_v, i) => `Sentence ${i}.`).join(' ');
        const diagnostics = makeViolation({ id: 'narrative', text: sentences });
        const feedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
        expect(feedback).toContain(String(cap + 3));
        expect(feedback).toContain(String(cap));
        expect(feedback.toLowerCase()).toContain('sentences');
    });

    it('joins multiple actionable narrative violations with newlines', () => {
        const sourceBudget = { layer: 'l0', targetTokens: 100 };
        const narrativeCap = computeSentenceCap('l0', 100);
        const narrativeText = Array.from(
            { length: narrativeCap + 2 },
            (_v, i) => `Sentence ${i}.`,
        ).join(' ');
        // Two above-hard-maximum sections in one diagnostics object.
        const diagnostics = buildRepairDiagnostics({
            sections: [
                { id: 'narrative', actualTokens: 100, hardMaxTokens: 1, text: narrativeText },
                { id: 'narrative', actualTokens: 100, hardMaxTokens: 1, text: narrativeText },
            ],
        });
        const feedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
        expect(feedback.split('\n')).toHaveLength(2);
    });
});
