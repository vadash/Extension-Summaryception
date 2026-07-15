import { describe, expect, it } from 'vitest';
import { buildRepairDiagnostics, getReductionGuidance } from '../src/core/repair-diagnostics.js';

describe('repair diagnostics', () => {
    it('describes common reduction ratios in plain language', () => {
        expect(getReductionGuidance(400, 200)).toBe('about half');
        expect(getReductionGuidance(300, 200)).toBe('about one-third');
    });

    it('returns structured violations with absolute desired and hard limits', () => {
        const diagnostics = buildRepairDiagnostics({
            scope: 'Layer 1+ promotion',
            totalTokens: 700,
            sections: [
                {
                    id: 'draft',
                    label: '[NARRATIVE]',
                    actualTokens: 700,
                    targetTokens: 400,
                    hardMaxTokens: 600,
                    text: 'Rejected narrative.',
                    preservationInstruction: 'retain macro chronology',
                },
            ],
            rejectedDraft: 'Rejected narrative.',
        });

        expect(diagnostics).toMatchObject({
            scope: 'Layer 1+ promotion',
            totalTokens: 700,
            rejectedDraft: 'Rejected narrative.',
            violations: [
                {
                    id: 'draft',
                    actualTokens: 700,
                    targetTokens: 400,
                    hardMaxTokens: 600,
                    reason: 'above-hard-maximum',
                    reductionGuidance: 'about two-fifths',
                    text: 'Rejected narrative.',
                    preservationInstruction: 'retain macro chronology',
                },
            ],
        });
    });
});
