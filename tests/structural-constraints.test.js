import { describe, expect, it } from 'vitest';

import {
    LAYER0_BUDGET_HINT,
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
        expect(buildSizeTargetLine({ label: '<narrative>', cap: 7, unit: 'sentences' })).toBe(
            '<narrative>: at most 7 sentences.',
        );
    });

    it('inserts a leading verb clause between the label and "at most"', () => {
        const result = buildSizeTargetLine({
            label: '<narrative>',
            cap: 7,
            unit: 'sentences',
            verb: 'compress the passage into;',
        });
        expect(result).toContain('compress the passage into');
        const verbIdx = result.indexOf('compress the passage into');
        const atMostIdx = result.indexOf('at most');
        expect(verbIdx).toBeLessThan(atMostIdx);
        expect(result.startsWith('<narrative>')).toBe(true);
    });

    it('appends a trailing extra after the period', () => {
        const result = buildSizeTargetLine({
            label: '<narrative>',
            cap: 7,
            unit: 'sentences',
            extra: 'Tail.',
        });
        expect(result.endsWith('Tail.')).toBe(true);
        expect(result).toContain('sentences.');
    });
});

describe('LAYER0_BUDGET_HINT', () => {
    it('wraps the source directive and carries no token figures and no sentence cap', () => {
        const result = LAYER0_BUDGET_HINT;
        expect(result).toContain('<budget>');
        expect(result).toContain('</budget>');
        expect(result).toContain('source:');
        // The sentence cap belongs to the recall limits, so a family's payload
        // is identical for every call (ADR-0033).
        expect(result).not.toMatch(/at most \d+ sentences/);
        expect(result).not.toContain('<narrative>');
        expect(result).not.toContain('[STATE]');
        // The model cannot count tokens, so none should appear in the hint.
        expect(/\d+\s*tokens?/i.test(result)).toBe(false);
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
