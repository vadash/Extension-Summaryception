import { describe, expect, it } from 'vitest';

import {
    buildLayer0BudgetHint,
    buildSizeConstraintsBlock,
    buildSizeTargetLine,
    computeSentenceCap,
    getSourceTokenCount,
} from '../src/core/token-budget.js';

describe('computeSentenceCap', () => {
    const degenerateTargets = [undefined, 0, -5, NaN];

    it.each(degenerateTargets)(
        'returns the minimum cap of 1 for a non-finite or non-positive target %s',
        (target) => {
            for (const layer of ['l0', 'l1', 'l2']) {
                expect(computeSentenceCap(layer, target)).toBe(1);
            }
        },
    );

    it('scales the cap upward as the slider target grows, for every layer band', () => {
        for (const layer of ['l0', 'l1', 'l2']) {
            expect(computeSentenceCap(layer, 400)).toBeGreaterThan(computeSentenceCap(layer, 100));
        }
    });

    it('preserves the intended layer ordering l0 > l1 > l2 at a large slider target', () => {
        // Promotions use a tighter safety multiplier than the direct L0 pass,
        // so both promotion bands (l1, l2) fall below l0. At the tested target
        // the per-band products of ratio, safety multiplier, and target differ
        // enough that Math.floor preserves the band ordering. A refactor that
        // intentionally re-orders the bands must update this test.
        const l0 = computeSentenceCap('l0', 2000);
        const l1 = computeSentenceCap('l1', 2000);
        const l2 = computeSentenceCap('l2', 2000);
        expect(l0).toBeGreaterThan(l1);
        expect(l1).toBeGreaterThan(l2);
    });

    it('maps numeric layer indices to the same bands as their string keys', () => {
        const T = 2000;
        expect(computeSentenceCap(0, T)).toBe(computeSentenceCap('l0', T));
        expect(computeSentenceCap(2, T)).toBe(computeSentenceCap('l2', T));
        // Any deep promotion index maps to the l2 band.
        expect(computeSentenceCap(5, T)).toBe(computeSentenceCap('l2', T));
    });

    it('floors tiny positive targets to the minimum cap of 1', () => {
        expect(computeSentenceCap('l0', 1)).toBe(1);
    });
});

describe('buildSizeTargetLine', () => {
    it('formats the minimal cap line without a verb or extra clause', () => {
        expect(buildSizeTargetLine({ label: '[NARRATIVE]', cap: 7, unit: 'sentences' })).toBe(
            '[NARRATIVE]: at most 7 sentences.',
        );
    });

    it('inserts a leading verb clause between the label and "at most"', () => {
        const result = buildSizeTargetLine({
            label: '[NARRATIVE]',
            cap: 7,
            unit: 'sentences',
            verb: 'compress the passage into;',
        });
        expect(result).toContain('compress the passage into');
        const verbIdx = result.indexOf('compress the passage into');
        const atMostIdx = result.indexOf('at most');
        expect(verbIdx).toBeLessThan(atMostIdx);
        expect(result.startsWith('[NARRATIVE]')).toBe(true);
    });

    it('appends a trailing extra after the period', () => {
        const result = buildSizeTargetLine({
            label: '[NARRATIVE]',
            cap: 7,
            unit: 'sentences',
            extra: 'Tail.',
        });
        expect(result.endsWith('Tail.')).toBe(true);
        expect(result).toContain('sentences.');
    });
});

describe('buildSizeConstraintsBlock', () => {
    it('wraps the target and repair lines between matching tags', () => {
        const result = buildSizeConstraintsBlock({
            wrapperTag: 'summaryception_promotion_constraints',
            targetLine: 'L',
            repairLine: 'R',
        });
        expect(result.startsWith('<summaryception_promotion_constraints>\nL')).toBe(true);
        expect(result).toContain('R</summaryception_promotion_constraints>');
        expect(result.endsWith('</summaryception_promotion_constraints>')).toBe(true);
    });

    it('still closes the wrapper when the repair line is omitted', () => {
        const result = buildSizeConstraintsBlock({
            wrapperTag: 'summaryception_promotion_constraints',
            targetLine: 'L',
        });
        expect(result.endsWith('</summaryception_promotion_constraints>')).toBe(true);
    });
});

describe('buildLayer0BudgetHint', () => {
    it('wraps the narrative sentence cap and never leaks token figures', () => {
        const result = buildLayer0BudgetHint({ targetTokens: 250 });
        expect(result).toContain('<summaryception_source_budget>');
        expect(result).toContain('</summaryception_source_budget>');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('sentences');
        expect(result).not.toContain('[STATE]');
        // The model cannot count tokens, so none should appear in the hint.
        expect(/\d+\s*tokens?/i.test(result)).toBe(false);
    });

    it('scales the cap with the slider target through computeSentenceCap', () => {
        const result = buildLayer0BudgetHint({ targetTokens: 2000 });
        expect(result).toContain(`at most ${computeSentenceCap('l0', 2000)} sentences`);
    });
});

describe('getSourceTokenCount', () => {
    it('prefers sourceTokensBefore', () => {
        expect(
            getSourceTokenCount({
                sourceTokensBefore: 100,
                regexStats: { finalTokens: 50 },
                memoryTokensBefore: 30,
            }),
        ).toBe(100);
    });

    it('falls to regexStats.finalTokens when sourceTokensBefore is absent', () => {
        expect(
            getSourceTokenCount({ regexStats: { finalTokens: 50 }, memoryTokensBefore: 30 }),
        ).toBe(50);
    });

    it('skips a zero sourceTokensBefore and uses regexStats.finalTokens', () => {
        expect(
            getSourceTokenCount({ sourceTokensBefore: 0, regexStats: { finalTokens: 50 } }),
        ).toBe(50);
    });

    it('falls to memoryTokensBefore last', () => {
        expect(getSourceTokenCount({ memoryTokensBefore: 30 })).toBe(30);
    });

    it.each([
        ['empty object', {}],
        ['no argument', undefined],
        ['negative', { sourceTokensBefore: -5 }],
        ['non-numeric', { sourceTokensBefore: 'abc' }],
    ])('returns 0 when no candidate is a positive number (%s)', (_label, metadata) => {
        expect(getSourceTokenCount(metadata)).toBe(0);
    });
});
