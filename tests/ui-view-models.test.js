import { describe, expect, it } from 'vitest';

import {
    buildContextBudgetViewModel,
    buildEnabledContentModel,
    buildTriggerGaugeModel,
    formatBudgetTokenLabel,
    getContextColorClass,
} from '../src/entry/ui-view-models.js';

const OFF_MODE = { mode: 'off', complexity: 'advanced', enabled: false };
const ON_EASY = { mode: 'on', complexity: 'easy', enabled: true };
const ON_ADVANCED = { mode: 'on', complexity: 'advanced', enabled: true };

describe('context budget color tiers', () => {
    it('keeps counts at or below a threshold in the tier below it', () => {
        expect(getContextColorClass(23999)).toBe('sc-ctx-safe');
        expect(getContextColorClass(24000)).toBe('sc-ctx-safe');
        expect(getContextColorClass(32000)).toBe('sc-ctx-warn');
        expect(getContextColorClass(48000)).toBe('sc-ctx-caution');
    });

    it('crosses into the next tier only strictly above each threshold', () => {
        expect(getContextColorClass(24001)).toBe('sc-ctx-warn');
        expect(getContextColorClass(32001)).toBe('sc-ctx-caution');
        expect(getContextColorClass(48001)).toBe('sc-ctx-danger');
        expect(getContextColorClass(50000)).toBe('sc-ctx-danger');
    });
});

describe('budget token labels', () => {
    it('ceil-normalizes counts and compacts them into k notation', () => {
        expect(formatBudgetTokenLabel(999)).toBe('999');
        expect(formatBudgetTokenLabel(4321.2)).toBe('4k');
        expect(formatBudgetTokenLabel(16000)).toBe('16k');
    });

    it('marks estimated counts with a tilde and normalizes unusable counts to zero', () => {
        expect(formatBudgetTokenLabel(500, true)).toBe('~500');
        expect(formatBudgetTokenLabel(-50.5)).toBe('0');
        expect(formatBudgetTokenLabel(undefined)).toBe('0');
    });
});

describe('context budget view model', () => {
    it('builds a plain-data model with sized segments and a free-space tail', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 2000, estimated: false },
            layers: [{ label: 'Layer 0', kind: 'memory', count: 3000, estimated: true }],
        });

        expect(view).toEqual({
            budget: 16000,
            used: 5000,
            overage: 0,
            denominator: 16000,
            totalLabel: '~5k / 16k',
            marker: null,
            segments: [
                {
                    label: 'Live Chat',
                    kind: 'verbatim',
                    count: 2000,
                    estimated: false,
                    percent: 12.5,
                    small: false,
                },
                {
                    label: 'Layer 0',
                    kind: 'memory',
                    count: 3000,
                    estimated: true,
                    percent: 18.75,
                    small: false,
                },
                {
                    label: 'Free Space',
                    kind: 'free',
                    count: 11000,
                    estimated: false,
                    percent: 68.75,
                    small: false,
                },
            ],
        });
    });

    it('positions the trigger marker as a percent of the denominator', () => {
        const view = buildContextBudgetViewModel({
            budget: 4000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1000, estimated: false },
            layers: [],
            marker: { positionTokens: 1500.4, label: 'Trigger' },
        });

        expect(view.denominator).toBe(4000);
        expect(view.marker).toEqual({ percent: 37.525, label: 'Trigger' });
    });

    it('reports overage past the budget and drops the free-space segment', () => {
        const view = buildContextBudgetViewModel({
            budget: 1000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1200, estimated: false },
            layers: [],
        });

        expect(view.overage).toBe(200);
        expect(view.segments).toEqual([
            {
                label: 'Live Chat',
                kind: 'verbatim',
                count: 1200,
                estimated: false,
                percent: 100,
                small: false,
            },
        ]);
    });

    it('flags segments below eight percent of the bar as small', () => {
        const view = buildContextBudgetViewModel({
            budget: 16000,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 1000, estimated: false },
            layers: [{ label: 'Deeper', kind: 'memory', count: 2000, estimated: false }],
        });

        const byLabel = Object.fromEntries(
            view.segments.map((segment) => [segment.label, segment]),
        );
        expect(byLabel['Live Chat'].percent).toBe(6.25);
        expect(byLabel['Live Chat'].small).toBe(true);
        expect(byLabel['Deeper'].percent).toBe(12.5);
        expect(byLabel['Deeper'].small).toBe(false);
    });
});

describe('trigger gauge model', () => {
    it('treats a missing work read model as an empty queue and ceil-normalizes the budget', () => {
        expect(buildTriggerGaugeModel(null, { queuedTokenBudget: 16000.4 })).toEqual({
            queuedTokens: 0,
            queuedEstimated: false,
            triggerTokens: 16001,
            label: 'Summarize at Recent + Queued',
        });
    });
});

describe('enabled content model', () => {
    it('shows the remembered panel while Off, with no run controls', () => {
        expect(buildEnabledContentModel(OFF_MODE, { autoPaused: false })).toEqual({
            modeLabel: 'Off',
            off: true,
            easyPanel: false,
            advancedPanel: true,
            continuitySection: false,
            stop: false,
            resume: false,
        });
    });

    it('gates the continuity section on the Advanced panel', () => {
        expect(buildEnabledContentModel(ON_ADVANCED, { autoPaused: false }).continuitySection).toBe(
            true,
        );
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: false }).continuitySection).toBe(
            false,
        );
    });

    it('swaps Stop for Resume while the Pause Latch is set', () => {
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: true })).toMatchObject({
            stop: false,
            resume: true,
        });
        expect(buildEnabledContentModel(ON_EASY, { autoPaused: false })).toMatchObject({
            stop: true,
            resume: false,
        });
    });

    it('labels the visible panel', () => {
        expect(buildEnabledContentModel(ON_EASY, {}).modeLabel).toBe('Easy');
        expect(buildEnabledContentModel(ON_ADVANCED, {}).modeLabel).toBe('Advanced');
    });
});
