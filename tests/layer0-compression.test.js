import { describe, it, expect } from 'vitest';
import {
    getLayer0SummaryTokenTarget,
    isLayer0CompressionCall,
    appendLayer0PromptConstraints,
} from '../src/core/layer0-compression.js';
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
        expect(result).toContain('Write the output mainly in English');
        expect(result).toContain('do not write Chinese prose or Han ideographs');
        expect(result).toContain('current_date_time');
        expect(result).not.toContain('timeline_start');
        expect(result).toContain('YYYY-MM-DD HH ddd');
        expect(result).toContain('physiological or sex counters');
        expect(result).toContain('static character background/profile facts');
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
    });

    it('appends repair feedback for promotion repair calls', () => {
        const result = appendLayer0PromptConstraints(
            'prompt',
            {},
            {
                kind: 'promotion',
                memoryTokensBefore: 1000,
                promotionRepair: {
                    outputTokens: 500,
                    requiredMaxTokens: 350,
                    rejectedSummary: 'Rejected verbose summary.',
                },
            },
        );
        expect(result).toContain('Repair task');
        expect(result).toContain('previous promotion draft failed');
        expect(result).toContain('500 tokens');
        expect(result).toContain('350 tokens or fewer');
        expect(result).toContain('<rejected_promotion_draft>');
        expect(result).toContain('Rejected verbose summary.');
    });

    it('returns prompt unchanged for non-compression calls', () => {
        const result = appendLayer0PromptConstraints('prompt', {}, { kind: 'other' });
        expect(result).toBe('prompt');
    });
});
