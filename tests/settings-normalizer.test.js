import { describe, expect, it } from 'vitest';

import {
    MEMORY_MODES,
    MEMORY_POSITIONS,
    SLIDER_LIMITS,
    defaultSettings,
} from '../src/foundation/constants.js';
import { CONNECTION_ROUTES } from '../src/foundation/connection-routes.js';
import { normalizeSettings } from '../src/foundation/settings-normalizer.js';

/**
 * The read-time Settings Normalization pass. It never touches the host, so a
 * stored settings object is the entire fixture: no installed SillyTavern
 * context, no chat metadata.
 */
function normalize(overrides = {}, stored = { hadMaskUserRoleMode: true }) {
    const settings = { ...defaultSettings, ...overrides };
    return { settings, changed: normalizeSettings(settings, stored) };
}

describe('normalizeSettings', () => {
    it('reports no change for a legal stored object', () => {
        expect(normalize().changed).toBe(false);
    });

    it('repairs the role mask reported as never stored', () => {
        const { settings, changed } = normalize({}, { hadMaskUserRoleMode: false });
        expect(changed).toBe(true);
        expect(settings.maskUserRoleMode).toBe(defaultSettings.maskUserRoleMode);
    });

    it('clamps without reporting a change, so the load path persists on repair only', () => {
        const { settings, changed } = normalize({ verbatimTokenBudget: 999 });
        expect(changed).toBe(false);
        expect(settings.verbatimTokenBudget).toBe(SLIDER_LIMITS.verbatimTokenBudget.MIN);
    });

    it('coerces the Continuity toggles to strict booleans and reports the repair', () => {
        const repaired = normalize({ continuityEnabled: 'yes' });
        expect(repaired.settings.continuityEnabled).toBe(false);
        expect(repaired.changed).toBe(true);

        expect(normalize().settings.continuityEnabled).toBe(false);
        expect(normalize({ continuityEnabled: true }).settings.continuityEnabled).toBe(true);
    });

    it('remaps persisted append-only mode to prefix_cache and resets invalid modes', () => {
        expect(normalize({ memoryMode: 'append_only' }).settings.memoryMode).toBe(
            MEMORY_MODES.PREFIX_CACHE,
        );
        expect(normalize({ memoryMode: 'not-a-mode' }).settings.memoryMode).toBe(
            MEMORY_MODES.BALANCED,
        );
    });

    it('moves the stored legacy placement pair to the chat-start default', () => {
        const { settings, changed } = normalize({
            customMemoryPosition: MEMORY_POSITIONS.IN_PROMPT,
            customMemoryDepth: 0,
        });

        expect(changed).toBe(true);
        expect(settings.customMemoryPosition).toBe(MEMORY_POSITIONS.IN_CHAT);
        expect(settings.customMemoryDepth).toBe(SLIDER_LIMITS.customMemoryDepth.MAX);
    });

    it('keeps an explicit non-default placement or depth', () => {
        const promptDepth = normalize({
            customMemoryPosition: MEMORY_POSITIONS.IN_PROMPT,
            customMemoryDepth: 5,
        });
        expect(promptDepth.changed).toBe(false);
        expect(promptDepth.settings.customMemoryPosition).toBe(MEMORY_POSITIONS.IN_PROMPT);
        expect(promptDepth.settings.customMemoryDepth).toBe(5);

        const chatDepth = normalize({
            customMemoryPosition: MEMORY_POSITIONS.IN_CHAT,
            customMemoryDepth: SLIDER_LIMITS.customMemoryDepth.MAX,
        });
        expect(chatDepth.changed).toBe(false);
        expect(chatDepth.settings.customMemoryPosition).toBe(MEMORY_POSITIONS.IN_CHAT);
        expect(chatDepth.settings.customMemoryDepth).toBe(SLIDER_LIMITS.customMemoryDepth.MAX);
    });

    it('defaults an invalid placement to the chat-start default', () => {
        const { settings } = normalize({ customMemoryPosition: 'bogus' });
        expect(settings.customMemoryPosition).toBe(MEMORY_POSITIONS.IN_CHAT);
    });

    it('defaults and clamps independent recent and queued budgets', () => {
        const { settings } = normalize({ verbatimTokenBudget: 999, queuedTokenBudget: 999999 });
        expect(settings).toMatchObject({
            verbatimTokenBudget: SLIDER_LIMITS.verbatimTokenBudget.MIN,
            queuedTokenBudget: SLIDER_LIMITS.queuedTokenBudget.MAX,
        });
    });

    it('clamps route timeouts above the slider max', () => {
        const { settings } = normalize({
            requestTimeoutSeconds: 8000,
            mergeRequestTimeoutSeconds: 8000,
            fallbackRequestTimeoutSeconds: 8000,
        });
        expect(settings).toMatchObject({
            requestTimeoutSeconds: SLIDER_LIMITS.requestTimeoutSeconds.MAX,
            mergeRequestTimeoutSeconds: SLIDER_LIMITS.mergeRequestTimeoutSeconds.MAX,
            fallbackRequestTimeoutSeconds: SLIDER_LIMITS.fallbackRequestTimeoutSeconds.MAX,
        });
    });

    it('clamps auditor route timeouts to the slider bounds', () => {
        const { settings } = normalize({
            auditorRequestTimeoutSeconds: 8000,
        });
        expect(settings).toMatchObject({
            auditorRequestTimeoutSeconds: SLIDER_LIMITS.auditorRequestTimeoutSeconds.MAX,
        });
    });

    it('defaults and clamps the provider cache TTL', () => {
        expect(normalize({ cacheTtlMinutes: 9999 }).settings.cacheTtlMinutes).toBe(
            SLIDER_LIMITS.cacheTtlMinutes.MAX,
        );
    });

    it('repairs any route source that no option accepts', () => {
        const overrides = {};
        for (const route of Object.values(CONNECTION_ROUTES)) {
            overrides[route.sourceKey] = 'bogus';
        }
        const { settings } = normalize(overrides);

        for (const route of Object.values(CONNECTION_ROUTES)) {
            expect(settings[route.sourceKey], route.sourceKey).toBe(
                defaultSettings[route.sourceKey],
            );
        }
    });

    it('resets invalid auditor connection sources to their defaults', () => {
        const { settings } = normalize({
            auditorConnectionSource: 'bogus',
        });
        expect(settings).toMatchObject({
            auditorConnectionSource: defaultSettings.auditorConnectionSource,
        });

        expect(
            normalize({ auditorConnectionSource: 'default' }).settings.auditorConnectionSource,
        ).toBe('default');
    });

    it('enforces the retention invariants after clamping', () => {
        const turns = normalize({ minSummaryTurns: 8, maxSummaryTurns: 2 }).settings;
        expect(turns.maxSummaryTurns).toBe(turns.minSummaryTurns);

        const budget = normalize({
            maxL0SourceTokens: SLIDER_LIMITS.maxL0SourceTokens.MIN,
            minSummaryBudget: SLIDER_LIMITS.minSummaryBudget.MAX,
        }).settings;
        expect(budget.minSummaryBudget).toBeLessThanOrEqual(budget.maxL0SourceTokens);
    });
});

describe('normalizeSettings recall profiles', () => {
    it('defaults both recall pairs when the stored preset is invalid', () => {
        const { settings, changed } = normalize({
            layer0RecallPreset: 'bogus',
            layer0RecallBody: 'drifted layer0 text',
            promotionRecallPreset: 'also-bogus',
            promotionRecallBody: 'drifted promotion text',
        });

        expect(changed).toBe(true);
        expect(settings.layer0RecallPreset).toBe(defaultSettings.layer0RecallPreset);
        expect(settings.layer0RecallBody).toBe(defaultSettings.layer0RecallBody);
        expect(settings.promotionRecallPreset).toBe(defaultSettings.promotionRecallPreset);
        expect(settings.promotionRecallBody).toBe(defaultSettings.promotionRecallBody);
    });

    it('forces the preset text over drifted text for a valid non-custom preset', () => {
        const { settings } = normalize({
            layer0RecallPreset: 'narrative',
            layer0RecallBody: 'stale shipped copy',
            promotionRecallPreset: 'narrative',
            promotionRecallBody: 'stale shipped copy',
        });

        expect(settings.layer0RecallBody).toBe(defaultSettings.layer0RecallBody);
        expect(settings.promotionRecallBody).toBe(defaultSettings.promotionRecallBody);
    });

    it('keeps non-blank custom recall text and defaults a blank custom body', () => {
        const kept = normalize({
            layer0RecallPreset: 'custom',
            layer0RecallBody: 'my recall checklist',
            promotionRecallPreset: 'custom',
            promotionRecallBody: 'my promotion checklist',
        }).settings;
        expect(kept.layer0RecallBody).toBe('my recall checklist');
        expect(kept.promotionRecallBody).toBe('my promotion checklist');

        const blank = normalize({
            layer0RecallPreset: 'custom',
            layer0RecallBody: '   ',
            promotionRecallPreset: 'custom',
            promotionRecallBody: '',
        }).settings;
        expect(blank.layer0RecallPreset).toBe(defaultSettings.layer0RecallPreset);
        expect(blank.layer0RecallBody).toBe(defaultSettings.layer0RecallBody);
        expect(blank.promotionRecallPreset).toBe(defaultSettings.promotionRecallPreset);
        expect(blank.promotionRecallBody).toBe(defaultSettings.promotionRecallBody);
    });
});
