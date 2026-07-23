import { describe, it, expect } from 'vitest';

import {
    computeNarrativeSentenceCap,
    computeStateLineCap,
    STATE_KEY_CEILING,
    NARRATIVE_SENTENCE_FLOOR,
    NARRATIVE_SENTENCE_CEILING,
} from '../src/core/token-budget/structural-constraints.js';
import { applySafetyGap, BUDGET_SAFETY_GAP_RATIO } from '../src/core/token-budget/safety-gap.js';
import { buildLayer0BudgetHint } from '../src/core/token-budget/budget-hint-builder.js';
import { buildStructuralRepairFeedback } from '../src/core/token-budget/repair-feedback-adapter.js';

describe('computeStateLineCap', () => {
    it('clamps to the ceiling of 7', () => {
        expect(computeStateLineCap(9)).toBe(7);
    });

    it('returns the count when below the ceiling', () => {
        expect(computeStateLineCap(3)).toBe(3);
    });

    it('falls back to the ceiling when the count is absent or invalid', () => {
        expect(computeStateLineCap(0)).toBe(7);
        expect(computeStateLineCap(undefined)).toBe(7);
        expect(computeStateLineCap(NaN)).toBe(7);
        expect(computeStateLineCap(-2)).toBe(7);
    });

    it('exposes the ceiling constant', () => {
        expect(STATE_KEY_CEILING).toBe(7);
    });
});

describe('computeNarrativeSentenceCap', () => {
    it('floors at the minimum for small sources', () => {
        expect(computeNarrativeSentenceCap(100)).toBe(3);
        expect(computeNarrativeSentenceCap(0)).toBe(3);
        expect(computeNarrativeSentenceCap(undefined)).toBe(3);
    });

    it('ceilings at the maximum for large sources', () => {
        expect(computeNarrativeSentenceCap(3000)).toBe(5);
        expect(computeNarrativeSentenceCap(100000)).toBe(5);
    });

    it('scales linearly between the floor and ceiling', () => {
        // ceil(1200 / 500) === 3
        expect(computeNarrativeSentenceCap(1200)).toBe(3);
        // ceil(2000 / 500) === 4
        expect(computeNarrativeSentenceCap(2000)).toBe(4);
    });

    it('exposes the floor and ceiling constants', () => {
        expect(NARRATIVE_SENTENCE_FLOOR).toBe(3);
        expect(NARRATIVE_SENTENCE_CEILING).toBe(5);
    });
});

describe('applySafetyGap', () => {
    it('rounds 90% of the real bound', () => {
        expect(applySafetyGap(300)).toBe(270);
        expect(applySafetyGap(200)).toBe(180);
    });

    it('returns 0 for non-finite input', () => {
        expect(applySafetyGap(NaN)).toBe(0);
        expect(applySafetyGap(undefined)).toBe(0);
    });

    it('exposes the 10% gap ratio', () => {
        expect(BUDGET_SAFETY_GAP_RATIO).toBe(0.9);
    });
});

describe('buildLayer0BudgetHint', () => {
    const baseNarrativeBounds = { target: 200, max: 300 };
    const baseStateBounds = { softTarget: 200, max: 300 };

    it('emits the source-relative budget block with 10%-gapped numbers and structural caps', () => {
        const hint = buildLayer0BudgetHint({
            sourceNarrativeTokens: 8000,
            sourceStateTokens: 120,
            sourceStateKeyCount: 5,
            narrativeBounds: baseNarrativeBounds,
            stateBounds: baseStateBounds,
        });

        expect(hint).toContain('<summaryception_source_budget>');
        expect(hint).toContain('Source passage: ~8000 tokens');
        // Safety-gapped numbers (90% of 200 / 300).
        expect(hint).toContain('aim ~180 tokens');
        expect(hint).toContain('never exceed 270');
        // Narrative sentence cap: ceil(8000 / 500) clamped to 5.
        expect(hint).toContain('At most 5 sentences.');
        // State key count present, line cap is min(5, 7) === 5.
        expect(hint).toContain('Existing [STATE]: ~120 tokens, 5 keys.');
        expect(hint).toContain('At most 5 lines.');
        // The plan's rejected wording must NOT appear.
        expect(hint).not.toContain('At most 5 key:value lines');
    });

    it('switches to the first-snapshot variant and the ceiling line cap when there is no prior [STATE]', () => {
        const hint = buildLayer0BudgetHint({
            sourceNarrativeTokens: 8000,
            sourceStateTokens: 0,
            sourceStateKeyCount: 0,
            narrativeBounds: baseNarrativeBounds,
            stateBounds: baseStateBounds,
        });

        expect(hint).toContain('No existing [STATE] yet — build the first snapshot.');
        expect(hint).toContain('At most 7 lines.');
        expect(hint).not.toContain('Existing [STATE]:');
    });

    it('returns no trailing newline', () => {
        const hint = buildLayer0BudgetHint({
            sourceNarrativeTokens: 8000,
            sourceStateTokens: 120,
            sourceStateKeyCount: 5,
            narrativeBounds: baseNarrativeBounds,
            stateBounds: baseStateBounds,
        });
        expect(hint.endsWith('\n')).toBe(false);
    });
});

describe('buildStructuralRepairFeedback', () => {
    function stateDiagnostics(text) {
        return {
            violations: [
                {
                    id: 'state',
                    label: '[STATE]',
                    reason: 'above-hard-maximum',
                    text,
                },
            ],
        };
    }

    function narrativeDiagnostics(text) {
        return {
            violations: [
                {
                    id: 'narrative',
                    label: '[NARRATIVE]',
                    reason: 'above-hard-maximum',
                    text,
                },
            ],
        };
    }

    it('emits a STATE line-count structural feedback when over the cap', () => {
        const stateText = Array.from({ length: 9 }, (_v, i) => `key${i}: val${i}`).join('\n');
        const feedback = buildStructuralRepairFeedback(stateDiagnostics(stateText), {
            sourceStateKeyCount: 9,
        });
        expect(feedback).toContain('maximum 7');
        expect(feedback).toContain('Remove the 2 least-durable keys.');
    });

    it('emits a NARRATIVE sentence-count structural feedback when over the cap', () => {
        const narrative = 'One. Two. Three. Four. Five. Six. Seven.';
        const feedback = buildStructuralRepairFeedback(narrativeDiagnostics(narrative), {
            sourceNarrativeTokens: 100,
        });
        expect(feedback).toContain('maximum 3');
        expect(feedback).toContain('Merge or drop the');
    });

    it('returns an empty string when there are no violations', () => {
        expect(buildStructuralRepairFeedback({ violations: [] }, {})).toBe('');
    });

    it('returns an empty string when the violating section is at or below the cap', () => {
        const stateText = 'a: 1\nb: 2';
        const feedback = buildStructuralRepairFeedback(stateDiagnostics(stateText), {
            sourceStateKeyCount: 7,
        });
        expect(feedback).toBe('');
    });

    it('ignores below-minimum violations', () => {
        const diagnostics = {
            violations: [
                {
                    id: 'narrative',
                    label: '[NARRATIVE]',
                    reason: 'below-minimum',
                    text: 'Short.',
                },
            ],
        };
        expect(buildStructuralRepairFeedback(diagnostics, { sourceNarrativeTokens: 100 })).toBe('');
    });
});
