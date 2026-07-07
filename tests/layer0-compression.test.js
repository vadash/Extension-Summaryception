import { describe, it, expect } from 'vitest';
import {
    getLayer0ResponseTokenCap,
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

describe('getLayer0ResponseTokenCap', () => {
    it('caps L0 summaries with a small buffer', () => {
        const cap = getLayer0ResponseTokenCap(
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0' },
        );
        expect(cap).toBe(250);
    });

    it('caps L0 at MAX_LAYER0_RESPONSE_TOKENS even for large targets', () => {
        const cap = getLayer0ResponseTokenCap(
            { layer0SummaryTokenTarget: 500 },
            { kind: 'layer0' },
        );
        expect(cap).toBe(384);
    });

    it('scales promotion caps with merged snippet count', () => {
        const cap3 = getLayer0ResponseTokenCap(
            { snippetsPerPromotion: 3 },
            { kind: 'promotion', mergedSnippetCount: 3, memoryTokensBefore: 1000 },
        );
        const cap6 = getLayer0ResponseTokenCap(
            { snippetsPerPromotion: 3 },
            { kind: 'promotion', mergedSnippetCount: 6, memoryTokensBefore: 1000 },
        );
        expect(cap6).toBeGreaterThan(cap3);
    });

    it('never exceeds the promotion maximum', () => {
        const cap = getLayer0ResponseTokenCap(
            { snippetsPerPromotion: 20 },
            { kind: 'promotion', mergedSnippetCount: 20, memoryTokensBefore: 50000 },
        );
        expect(cap).toBeLessThanOrEqual(2048);
    });

    it('never drops below the promotion minimum', () => {
        const cap = getLayer0ResponseTokenCap(
            { snippetsPerPromotion: 3 },
            { kind: 'promotion', mergedSnippetCount: 1, memoryTokensBefore: 50 },
        );
        expect(cap).toBeGreaterThanOrEqual(512);
    });

    it('provides a larger cap for promotions than L0', () => {
        const l0Cap = getLayer0ResponseTokenCap(
            { layer0SummaryTokenTarget: 200 },
            { kind: 'layer0' },
        );
        const promoCap = getLayer0ResponseTokenCap(
            { snippetsPerPromotion: 3 },
            { kind: 'promotion', mergedSnippetCount: 3, memoryTokensBefore: 1000 },
        );
        expect(promoCap).toBeGreaterThan(l0Cap);
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
            },
        );
        expect(result).toContain('summaryception_l0_constraints');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('[STATE]');
        expect(result).toContain('current_date_time');
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
        expect(result).toContain('2024-12-03 06 Wed');
        expect(result).toContain('unknown spans');
        expect(result).toContain('Fold any critical changes in state');
    });

    it('returns prompt unchanged for non-compression calls', () => {
        const result = appendLayer0PromptConstraints('prompt', {}, { kind: 'other' });
        expect(result).toBe('prompt');
    });
});
