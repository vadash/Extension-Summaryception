import { describe, it, expect } from 'vitest';
import {
    MODULE_NAME,
    LOG_PREFIX,
    defaultSettings,
    PROMPT_PRESETS,
    DEFAULT_PROMPT_PRESET,
    RETRY_CONFIG,
} from '../src/foundation/constants.js';

describe('constants', () => {
    it('exports the module name used for chatMetadata extensionSettings keys', () => {
        expect(MODULE_NAME).toBe('summaryception');
    });

    it('prefixes log output consistently with AGENTS.md convention', () => {
        expect(LOG_PREFIX).toBe('[Summaryception]');
    });

    it('freezes defaultSettings so agents cannot mutate the source of truth', () => {
        expect(Object.isFrozen(defaultSettings)).toBe(true);
    });

    it('provides sane dynamic verbatim window defaults', () => {
        expect(defaultSettings.minSummaryTurns).toBe(3);
        expect(defaultSettings.maxSummaryTurns).toBe(5);
        expect(defaultSettings.maxSummaryTurns).toBeGreaterThanOrEqual(
            defaultSettings.minSummaryTurns,
        );
        expect(defaultSettings.minSummaryBudget).toBe(6000);
        expect(defaultSettings.verbatimTokenBudget).toBe(16000);
        expect(defaultSettings.snippetsPerLayer).toBeGreaterThan(
            defaultSettings.snippetsPerPromotion,
        );
        expect(defaultSettings.maxLayers).toBeGreaterThanOrEqual(1);
    });

    it('configures exponential-backoff retry within 2s..60s bounds', () => {
        expect(RETRY_CONFIG.maxRetries).toBe(5);
        expect(RETRY_CONFIG.baseDelay).toBeLessThanOrEqual(RETRY_CONFIG.maxDelay);
        expect(RETRY_CONFIG.maxDelay).toBe(60000);
        expect(RETRY_CONFIG.backoffMultiplier).toBeGreaterThan(1);
    });

    it('declares retryable HTTP statuses for transient failures', () => {
        expect(RETRY_CONFIG.retryableStatuses).toEqual([429, 500, 502, 503, 504]);
    });

    it('exposes every documented prompt preset', () => {
        expect(Object.keys(PROMPT_PRESETS).sort()).toEqual(['custom', 'gamestate', 'narrative']);
        expect(PROMPT_PRESETS.custom).toBeNull();
        expect(PROMPT_PRESETS.narrative).toContain('{{story_txt}}');
        expect(PROMPT_PRESETS.gamestate).toContain('{{story_txt}}');
    });

    it('defaults to the narrative preset', () => {
        expect(DEFAULT_PROMPT_PRESET).toBe('narrative');
    });

    it('strips common reasoning tokens by default', () => {
        expect(defaultSettings.stripPatterns).toContain('<|channel>thought');
        expect(defaultSettings.stripPatterns).toContain('<thinking>');
    });
});
