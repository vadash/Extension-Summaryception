import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/foundation/constants.js';
import {
    appendLayer0PromptConstraints,
    buildLayer0SizeRepairFeedback,
    buildStateSnapshotSizeRepairFeedback,
    getLayer0SummaryTokenBounds,
    getLayer0SummaryTokenTarget,
    isLayer0CompressionCall,
    isLayer0SizeGuardCall,
    validateLayer0OutputSize,
} from '../src/core/layer0-compression.js';
import {
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
    buildUserPrompt,
} from '../src/foundation/prompt-parts.js';
import { LAYER_HARD_MAX_RATIO } from '../src/core/token-budget.js';
import {
    getPromotionSummaryTokenHardMax,
    getPromotionSummaryTokenTarget,
} from '../src/core/promotion-planner.js';
import { installSummaryContext } from './test-helpers.js';

function makeLayer0Prompt(triggerLine) {
    return buildUserPrompt({
        inputBlocks: '<source>chat</source>',
        schemaBlock: 'schema',
        taskRules: 'rules',
        criticalRules: '',
        triggerLine,
    });
}

describe('isLayer0CompressionCall', () => {
    it.each([['layer0'], ['regenerate'], ['promotion']])('is true for kind %s', (kind) => {
        expect(isLayer0CompressionCall({ kind })).toBe(true);
    });

    it.each([[{ kind: 'other' }], [{}], [undefined]])('is false for %o', (metadata) => {
        expect(isLayer0CompressionCall(metadata)).toBe(false);
    });
});

describe('isLayer0SizeGuardCall', () => {
    it.each([['layer0'], ['regenerate']])('is true for kind %s', (kind) => {
        expect(isLayer0SizeGuardCall({ kind })).toBe(true);
    });

    it('is false for promotion; the load-bearing asymmetry vs isLayer0CompressionCall', () => {
        expect(isLayer0SizeGuardCall({ kind: 'promotion' })).toBe(false);
        expect(isLayer0CompressionCall({ kind: 'promotion' })).toBe(true);
    });
});

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

describe('appendLayer0PromptConstraints', () => {
    const settings = { layer0SummaryTokenTarget: 200 };

    it('returns the prompt unchanged when the call is not a compression call', () => {
        const prompt = makeLayer0Prompt(EXECUTION_TRIGGER_L0);
        expect(appendLayer0PromptConstraints(prompt, settings, {})).toBe(prompt);
    });

    it('inserts the budget hint before the trigger and preserves L0 trigger finality', () => {
        const prompt = makeLayer0Prompt(EXECUTION_TRIGGER_L0);
        const result = appendLayer0PromptConstraints(prompt, settings, {
            kind: 'layer0',
            budgetHint: 'BUDGET_HINT_MARKER',
        });
        expect(result).toContain('BUDGET_HINT_MARKER');
        expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_L0)).toBe(true);
    });

    it('references both source-range numbers when sourceRange is a [start, end] pair', () => {
        const prompt = makeLayer0Prompt(EXECUTION_TRIGGER_L0);
        const result = appendLayer0PromptConstraints(prompt, settings, {
            kind: 'layer0',
            sourceRange: [12, 34],
        });
        expect(result).toContain('12');
        expect(result).toContain('34');
        expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_L0)).toBe(true);
    });

    it('adds no source-range line for an absent or too-short range but keeps trigger finality', () => {
        const prompt = makeLayer0Prompt(EXECUTION_TRIGGER_L0);
        const result = appendLayer0PromptConstraints(prompt, settings, {
            kind: 'layer0',
            sourceRange: [5],
        });
        expect(result).not.toContain('covers chat messages');
        expect(result.trimEnd().endsWith(EXECUTION_TRIGGER_L0)).toBe(true);
    });

    it('delegates promotion calls to the promotion path, differing from input and keeping the promotion trigger', () => {
        const prompt = makeLayer0Prompt(EXECUTION_TRIGGER_PROMO);
        const result = appendLayer0PromptConstraints(prompt, settings, {
            kind: 'promotion',
            layerIndex: 0,
            targetTokens: 1000,
        });
        expect(result).not.toBe(prompt);
        expect(result).toContain(EXECUTION_TRIGGER_PROMO);
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
        expect(output).toContain('<summaryception_l0_repair_feedback>');
        expect(output).toContain('</summaryception_l0_repair_feedback>');
        expect(output).toContain('[NARRATIVE]');
        expect(output).toContain('[STATE]');
    });

    it('flags the narrative below-minimum when reason is too-short', () => {
        const output = buildLayer0SizeRepairFeedback({
            reason: 'too-short',
            outputTokens: 10,
            bounds,
        });
        // The synthesized narrative section carries no text, so it appears as a
        // rejection header line rather than a <rejected_narrative> body block.
        expect(output).toContain('[NARRATIVE]: rejected.');
    });
});

describe('buildStateSnapshotSizeRepairFeedback', () => {
    it('routes through the L0 repair wrapper and includes the rejected state text', () => {
        const output = buildStateSnapshotSizeRepairFeedback({
            stateTokens: 100000,
            stateText: 'STATE_SNAPSHOT_MARKER: value',
        });
        expect(output).toContain('<summaryception_l0_repair_feedback>');
        expect(output).toContain('STATE_SNAPSHOT_MARKER: value');
    });
});

describe('validateLayer0OutputSize', () => {
    it('accepts a Layer 0 draft whose sections sit inside the configured size band', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 100 });
        const output = [
            '[NARRATIVE]',
            'Kaelen traded the map for safe passage and left before dawn.',
            '',
            '[STATE]',
            'location: the river dock',
            'bonds: owes Harl a favor',
        ].join('\n');

        const result = await validateLayer0OutputSize(output, defaultSettings, { kind: 'layer0' });

        expect(result.valid).toBe(true);
        expect(result.error).toBeNull();
        expect(result.repairFeedback).toBe('');
    });

    it('rejects an oversized Layer 0 draft with violations and non-empty repair feedback', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 500 });
        const output = [
            '[NARRATIVE]',
            'Kaelen argued with the ferryman about the fare and watched the storm roll in.',
            '',
            '[STATE]',
            'location: the river dock',
        ].join('\n');

        const result = await validateLayer0OutputSize(output, defaultSettings, { kind: 'layer0' });

        expect(result.valid).toBe(false);
        expect(result.error).toBeInstanceOf(Error);
        expect(result.diagnostics.violations.length).toBeGreaterThan(0);
        expect(result.repairFeedback.length).toBeGreaterThan(0);
    });

    it('passes a draft through untouched when the call is not a Layer 0 size-guard call', async () => {
        installSummaryContext({ getTokenCountAsync: async () => 500 });

        const result = await validateLayer0OutputSize(
            '[NARRATIVE]\nAny draft\n\n[STATE]\nlocation: the river dock',
            defaultSettings,
            { kind: 'promotion' },
        );

        expect(result).toEqual({ valid: true, error: null, repairFeedback: '' });
    });
});
