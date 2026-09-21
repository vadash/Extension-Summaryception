import { describe, expect, it } from 'vitest';

import { MEMORY_MODES, SLIDER_LIMITS, defaultSettings } from '../src/foundation/constants.js';
import { CONNECTION_ROUTES } from '../src/foundation/connection-routes.js';
import { normalizeSettings } from '../src/foundation/settings-normalizer.js';

/**
 * The read-time Settings Normalization pass. It never touches the host, so a
 * stored settings object is the entire fixture — no installed SillyTavern
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
