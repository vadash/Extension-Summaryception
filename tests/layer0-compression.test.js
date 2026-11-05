import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/foundation/constants.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    buildCompressionLimits,
    buildCompressionPayloadFragments,
    buildLayer0SizeRepairFeedback,
    getLayer0SummaryTokenBounds,
    getLayer0SummaryTokenTarget,
    validateLayer0OutputSize,
} from '../src/core/layer0-compression.js';
import { LAYER_HARD_MAX_RATIO } from '../src/core/token-budget.js';
import {
    getPromotionSummaryTokenHardMax,
    getPromotionSummaryTokenTarget,
} from '../src/core/promotion-planner.js';
import { installSummaryContext } from './test-helpers.js';

describe('getLayer0SummaryTokenTarget', () => {
    it('clamps a too-large target down and a too-small one up, preserving ordering', () => {
        const tooSmall = getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: -50 });
        const valid = getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 200 });
        const tooLarge = getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 100000 });
        expect(tooSmall).toBeLessThanOrEqual(valid);
        expect(valid).toBeLessThanOrEqual(tooLarge);
    });

    it('clamps two enormous targets to the same ceiling value', () => {
        const huge = getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 100000 });
        const alsoHuge = getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 500000 });
        expect(huge).toBe(alsoHuge);
    });

    it('rounds a valid mid-range value through', () => {
        expect(getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: 199.4 })).toBe(199);
    });

    it('falls back to the default setting for a non-finite target', () => {
        expect(getLayer0SummaryTokenTarget({ layer0SummaryTokenTarget: NaN })).toBe(
            defaultSettings.layer0SummaryTokenTarget,
        );
    });
});

describe('getLayer0SummaryTokenBounds', () => {
    it('allows compact narratives down to 50 tokens without changing the hard max', () => {
        const settings = { layer0SummaryTokenTarget: 200 };
        const bounds = getLayer0SummaryTokenBounds(settings);
        const target = getLayer0SummaryTokenTarget(settings);
        expect(bounds.target).toBe(target);
        expect(bounds.max).toBe(Math.round(target * LAYER_HARD_MAX_RATIO.l0));
        expect(bounds.min).toBeLessThan(bounds.target);
        expect(bounds.target).toBeLessThan(bounds.max);
    });
});

describe('getPromotionSummaryTokenTarget', () => {
    it('floors to at least 1 for a tiny targetTokens', () => {
        expect(getPromotionSummaryTokenTarget({ layerIndex: 0, targetTokens: 1 })).toBe(1);
    });
});

describe('getPromotionSummaryTokenHardMax', () => {
    it('yields a hard max no smaller than the target for the same inputs', () => {
        const args = { layerIndex: 0, targetTokens: 1000 };
        expect(getPromotionSummaryTokenHardMax(args)).toBeGreaterThanOrEqual(
            getPromotionSummaryTokenTarget(args),
        );
    });
});

describe('buildCompressionPayloadFragments', () => {
    const settings = { layer0SummaryTokenTarget: 200 };

    it('returns no fragment when the call is not a compression call', () => {
        expect(
            buildCompressionPayloadFragments(
                settings,
                resolveCallProfile(settings, { kind: 'auditor' }),
            ),
        ).toBe('');
    });

    it('carries the budget hint and no sentence cap', () => {
        const fragments = buildCompressionPayloadFragments(
            settings,
            resolveCallProfile(settings, { kind: 'layer0' }),
        );

        expect(fragments).toContain('<budget>');
        expect(fragments).toContain('</budget>');
        expect(fragments).not.toMatch(/at most \d+ sentences/);
        expect(fragments).not.toContain('[STATE]');
    });

    it('references both source-range numbers when sourceRange is a [start, end] pair', () => {
        const fragments = buildCompressionPayloadFragments(
            settings,
            resolveCallProfile(settings, { kind: 'layer0', sourceRange: [12, 34] }),
        );

        expect(fragments).toContain('12');
        expect(fragments).toContain('34');
    });

    it('adds no source-range line for an absent or too-short range', () => {
        const fragments = buildCompressionPayloadFragments(
            settings,
            resolveCallProfile(settings, { kind: 'layer0', sourceRange: [5] }),
        );

        expect(fragments).not.toContain('passage range:');
    });
});

describe('buildCompressionLimits', () => {
    const settings = { layer0SummaryTokenTarget: 200 };

    it('returns no limit lines when the call is not a compression call', () => {
        expect(
            buildCompressionLimits(settings, resolveCallProfile(settings, { kind: 'auditor' })),
        ).toEqual([]);
    });

    it('states the Layer 0 sentence cap in the limits', () => {
        const limits = buildCompressionLimits(
            settings,
            resolveCallProfile(settings, { kind: 'layer0' }),
        );

        expect(limits).toHaveLength(1);
        expect(limits[0]).toMatch(/^<narrative>: write at most \d+ sentences\.$/);
    });

    it('scales the cap with the configured target', () => {
        const small = buildCompressionLimits(
            { layer0SummaryTokenTarget: 200 },
            resolveCallProfile({ layer0SummaryTokenTarget: 200 }, { kind: 'layer0' }),
        );
        const large = buildCompressionLimits(
            { layer0SummaryTokenTarget: 2000 },
            resolveCallProfile({ layer0SummaryTokenTarget: 2000 }, { kind: 'layer0' }),
        );

        expect(small[0]).not.toBe(large[0]);
    });

    it('routes promotion calls to the promotion limits and keeps the target line first', () => {
        const limits = buildCompressionLimits(
            settings,
            resolveCallProfile(settings, { kind: 'promotion', layerIndex: 1 }),
        );

        expect(limits[0]).toMatch(/^<narrative>: merge into at most \d+ sentences\./);
        expect(limits[0]).toContain('Deep-layer fold');
    });

    it('renders the promotion repair reason after the target line', () => {
        const limits = buildCompressionLimits(
            settings,
            resolveCallProfile(settings, {
                kind: 'promotion',
                layerIndex: 0,
                promotionRepair: {
                    reason: 'too-long',
                    outputTokens: 900,
                    hardMaxTokens: 300,
                    targetTokens: 200,
                    rejectedSummary: 'One long sentence about the scene replay.',
                },
            }),
        );

        const repairIndex = limits.findIndex((line) => line.startsWith('repair:'));
        expect(repairIndex).toBeGreaterThan(0);
        expect(limits[0]).toMatch(/^<narrative>: merge into at most/);
    });
});

describe('buildLayer0SizeRepairFeedback', () => {
    const bounds = { target: 200, min: 80, max: 300 };

    it('builds diagnostics from bounds and wraps them with the L0 repair wrapper and footer directive', () => {
        const output = buildLayer0SizeRepairFeedback({
            reason: 'too-long',
            outputTokens: 500,
            bounds,
        });
        expect(output).toContain('<feedback>');
        expect(output).toContain('</feedback>');
        expect(output).toContain('<narrative>');
        // The repair ask names the narrative section only, so no state
        // section may appear in the feedback.
        expect(output).not.toContain('[STATE]');
    });

    it('flags the narrative below-minimum when reason is too-short', () => {
        const output = buildLayer0SizeRepairFeedback({
            reason: 'too-short',
            outputTokens: 10,
            bounds,
        });
        // The synthesized narrative section carries no text, so it appears as a
        // rejection header line rather than a <rejected> body block.
        expect(output).toContain('<narrative>: rejected.');
        expect(output).not.toContain('<rejected>');
    });
});

describe('validateLayer0OutputSize', () => {
    it('accepts a narrative-only Layer 0 draft inside the configured size band', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 100 });
        const output = [
            '<narrative>',
            'Kaelen traded the map for safe passage and left before dawn.',
            '</narrative>',
            '',
            'current_date_time: 2024-07-04 16 Thu',
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            resolveCallProfile(defaultSettings, { kind: 'layer0' }),
        );

        expect(result.valid).toBe(true);
        expect(result.error).toBeNull();
        expect(result.repairFeedback).toBe('');
    });

    it('rejects an oversized Layer 0 draft with violations and non-empty repair feedback', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 500 });
        const output = [
            '<narrative>',
            'Kaelen argued with the ferryman about the fare and watched the storm roll in.',
            '</narrative>',
        ].join('\n');

        const result = await validateLayer0OutputSize(
            output,
            resolveCallProfile(defaultSettings, { kind: 'layer0' }),
        );

        expect(result.valid).toBe(false);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.diagnostics.violations.length).toBeGreaterThan(0);
        expect(result.repairFeedback.length).toBeGreaterThan(0);
    });

    it('passes a draft through untouched when the call is not a Layer 0 size-guard call', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 500 });

        const result = await validateLayer0OutputSize(
            '<narrative>\nAny narrative-only draft\n</narrative>',
            resolveCallProfile(defaultSettings, { kind: 'promotion' }),
        );

        expect(result).toEqual({ valid: true, error: null, repairFeedback: '' });
    });
});
