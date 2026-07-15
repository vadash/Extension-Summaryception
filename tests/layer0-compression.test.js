import { describe, it, expect } from 'vitest';
import {
    buildLayer0SizeRepairFeedback,
    getLayer0SummaryTokenBounds,
    getLayer0SummaryTokenTarget,
    isLayer0SizeGuardCall,
    isLayer0CompressionCall,
    appendLayer0PromptConstraints,
} from '../src/core/layer0-compression.js';
import { buildRepairDiagnostics } from '../src/core/repair-diagnostics.js';
import { defaultSettings } from '../src/foundation/constants.js';

describe('getLayer0SummaryTokenTarget', () => {
    it('returns the configured target clamped to bounds', () => {
        expect(getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 200 })).toBe(200);
        expect(getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 10 })).toBe(80);
        expect(getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 99999 })).toBe(500);
    });

    it('falls back to the default when missing', () => {
        expect(getLayer0SummaryTokenTarget({})).toBe(defaultSettings.layer0SummaryTokenTarget);
    });
});

describe('getLayer0SummaryTokenBounds', () => {
    it('derives the accepted output range from the configured target', () => {
        expect(getLayer0SummaryTokenBounds({ layer0SummaryTokenTarget: 200 })).toEqual({
            target: 200,
            min: 66,
            max: 300,
        });
    });
});

describe('isLayer0CompressionCall', () => {
    it('returns true for layer0, regenerate, and promotion', () => {
        expect(isLayer0CompressionCall({ kind: 'layer0' })).toBe(true);
        expect(isLayer0CompressionCall({ kind: 'regenerate' })).toBe(true);
        expect(isLayer0CompressionCall({ kind: 'promotion' })).toBe(true);
    });

    it('returns false for unknown kinds', () => {
        expect(isLayer0CompressionCall({ kind: 'other' })).toBe(false);
        expect(isLayer0CompressionCall({})).toBe(false);
    });
});

describe('isLayer0SizeGuardCall', () => {
    it('returns true only for Layer 0 summary outputs', () => {
        expect(isLayer0SizeGuardCall({ kind: 'layer0' })).toBe(true);
        expect(isLayer0SizeGuardCall({ kind: 'regenerate' })).toBe(true);
        expect(isLayer0SizeGuardCall({ kind: 'promotion' })).toBe(false);
        expect(isLayer0SizeGuardCall({})).toBe(false);
    });
});

describe('buildLayer0SizeRepairFeedback', () => {
    it('includes rejected sections, absolute limits, and passing-section preservation', () => {
        const diagnostics = buildRepairDiagnostics({
            scope: 'Layer 0',
            totalTokens: 410,
            sections: [
                {
                    id: 'narrative',
                    label: '[NARRATIVE]',
                    actualTokens: 400,
                    targetTokens: 200,
                    hardMaxTokens: 300,
                    text: 'Rejected verbose narrative.',
                },
                {
                    id: 'state',
                    label: '[STATE]',
                    actualTokens: 10,
                    targetTokens: 200,
                    hardMaxTokens: 300,
                    text: 'current_date_time: 2026-07-15 17 Wed',
                    preservationInstruction: 'keep accepted state exactly',
                },
            ],
            rejectedDraft: 'draft',
        });
        const result = buildLayer0SizeRepairFeedback({
            diagnostics,
        });

        expect(result).toContain('summaryception_l0_repair_feedback');
        expect(result).toContain('[NARRATIVE]: 400 tokens; target 200; hard maximum 300');
        expect(result).toContain('reduce by about half');
        expect(result).toContain('<rejected_narrative>');
        expect(result).toContain('Rejected verbose narrative.');
        expect(result).toContain('Preserve [STATE] unchanged');
        expect(result).toContain('<preserve_state>');
    });
});

describe('appendLayer0PromptConstraints', () => {
    it('appends constraints for layer0 calls', () => {
        const result = appendLayer0PromptConstraints(
            'prompt',
            { layer0SummaryTokenTarget: 200 },
            {
                kind: 'layer0',
                sourceRange: [12, 34],
            },
        );
        expect(result).toContain('summaryception_l0_constraints');
        expect(result).toContain('This passage covers chat messages 12-34');
        expect(result).toContain('Message 34 is the latest summarized message');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('[STATE]');
        expect(result).toContain('[NARRATIVE] target: about 200 tokens; never exceed 300 tokens');
        expect(result).toContain('Keep [STATE] near 200 tokens');
        expect(result).toContain('Write the output mainly in English');
        expect(result).toContain('do not write Chinese prose or Han ideographs');
        expect(result).toContain('current_date_time');
        expect(result).not.toContain('timeline_start');
        expect(result).toContain('YYYY-MM-DD HH ddd');
        expect(result).toContain('physiological or sex counters');
        expect(result).toContain('static character background/profile facts');
        expect(result).toContain('short, direct sentences');
        expect(result).toContain('run-on sentences');
        expect(result).toContain('Prefer periods over commas and semicolons');
    });

    it('appends narrative-only constraints for promotion calls', () => {
        const result = appendLayer0PromptConstraints(
            'prompt',
            {},
            {
                kind: 'promotion',
                memoryTokensBefore: 1000,
            },
        );
        expect(result).toContain('summaryception_promotion_constraints');
        expect(result).toContain('Soft target: about 400 tokens');
        expect(result).toContain('Hard maximum: 600 tokens');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('Do not output a [STATE] block');
        expect(result).toContain('Write the output mainly in English');
        expect(result).toContain('do not write Chinese prose or Han ideographs');
        expect(result).toContain('exactly one dense paragraph');
        expect(result).toContain('no more than 4 to 5 sentences');
        expect(result).toContain('macro-level durable chronology');
        expect(result).toContain('[msgs 100-120; current 2024-12-03 09 Wed]');
        expect(result).toContain('unknown spans');
        expect(result).toContain('Fold any critical changes in state');
        expect(result).toContain('short, direct sentences');
        expect(result).toContain('run-on sentences');
        expect(result).toContain('Prefer periods over commas and semicolons');
    });

    it('appends repair feedback for promotion repair calls', () => {
        const result = appendLayer0PromptConstraints(
            'prompt',
            {},
            {
                kind: 'promotion',
                memoryTokensBefore: 1000,
                promotionRepair: {
                    outputTokens: 700,
                    targetTokens: 400,
                    hardMaxTokens: 600,
                    rejectedSummary: 'Rejected verbose summary.',
                },
            },
        );
        expect(result).toContain('Repair task');
        expect(result).toContain('previous Layer 1+ promotion draft failed');
        expect(result).toContain('700 tokens');
        expect(result).toContain('target 400');
        expect(result).toContain('hard maximum 600');
        expect(result).toContain('reduce by about two-fifths');
        expect(result).toContain('<rejected_promotion_draft>');
        expect(result).toContain('Rejected verbose summary.');
    });

    it('returns prompt unchanged for non-compression calls', () => {
        const result = appendLayer0PromptConstraints('prompt', {}, { kind: 'other' });
        expect(result).toBe('prompt');
    });
});
