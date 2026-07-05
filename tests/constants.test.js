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
        expect(defaultSettings.memoryMode).toBe('standard');
        expect(defaultSettings.customMemoryPosition).toBe('in_prompt');
        expect(defaultSettings.customMemoryRole).toBe('system');
        expect(defaultSettings.customMemoryDepth).toBe(0);
        expect(defaultSettings.minSummaryTurns).toBe(3);
        expect(defaultSettings.maxSummaryTurns).toBe(8);
        expect(defaultSettings.layer0SummaryTokenTarget).toBe(150);
        expect(defaultSettings.maxSummaryTurns).toBeGreaterThanOrEqual(
            defaultSettings.minSummaryTurns,
        );
        expect(defaultSettings.minSummaryBudget).toBe(8000);
        expect(defaultSettings.verbatimTokenBudget).toBe(16000);
        expect(defaultSettings.memoryTokenBudget).toBe(10000);
        expect(defaultSettings.snippetsPerPromotion).toBe(4);
        expect(defaultSettings.snippetsPerLayer).toBeGreaterThan(
            defaultSettings.snippetsPerPromotion,
        );
        expect(defaultSettings.maxLayers).toBeUndefined();
        expect(defaultSettings.promptInputLogMode).toBe(false);
        expect(defaultSettings.promptOutputLogMode).toBe(false);
        expect(defaultSettings.promptLogMode).toBe(false);
    });

    it('uses the Summaryception memory wrapper by default', () => {
        expect(defaultSettings.injectionTemplate).toContain('<summaryception_memory>');
        expect(defaultSettings.injectionTemplate).toContain(
            'higher-numbered <Lx> layers are older',
        );
        expect(defaultSettings.injectionTemplate).toContain('<L0> closest');
        expect(defaultSettings.injectionTemplate).toContain('{{summary}}');
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
        expect(PROMPT_PRESETS.narrative).toContain('TARGET');
        expect(PROMPT_PRESETS.narrative).toContain('runtime Layer 0 target length');
        expect(PROMPT_PRESETS.narrative).not.toContain('about 150 tokens');
        expect(PROMPT_PRESETS.narrative).toContain('durable state');
        expect(PROMPT_PRESETS.gamestate).toContain('{{story_txt}}');
    });

    it('defaults to the narrative preset', () => {
        expect(DEFAULT_PROMPT_PRESET).toBe('narrative');
        expect(defaultSettings.promptPreset).toBe(DEFAULT_PROMPT_PRESET);
        expect(defaultSettings.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
    });

    it('provides separate Layer 1+ promotion prompts', () => {
        expect(defaultSettings.promotionSystemPrompt).toContain('memory synthesizer');
        expect(defaultSettings.promotionUserPrompt).toContain('{{context_str}}');
        expect(defaultSettings.promotionUserPrompt).toContain('{{story_txt}}');
        expect(defaultSettings.promotionUserPrompt).toContain('memories_to_consolidate');
        expect(defaultSettings.promotionUserPrompt).toContain('immutable baseline history');
        expect(defaultSettings.promotionUserPrompt).toContain('Strict Delta Scoping');
        expect(defaultSettings.promotionUserPrompt).toContain('Temporal Anchors');
        expect(defaultSettings.promotionUserPrompt).toContain('Saturday Oct 19, 7PM');
        expect(defaultSettings.promotionUserPrompt).toContain('full dates over bare weekdays');
    });

    it('strips common reasoning tokens by default', () => {
        expect(defaultSettings.stripPatterns).toContain('<|channel>thought');
        expect(defaultSettings.stripPatterns).toContain('<thinking>');
    });

    it('keeps the Layer 1+ merge connection inherited by default', () => {
        expect(defaultSettings.mergeConnectionSource).toBe('inherit');
        expect(defaultSettings.mergeConnectionProfileId).toBe('');
        expect(defaultSettings.mergeOllamaModel).toBe('');
        expect(defaultSettings.mergeOpenaiModel).toBe('');
        expect(defaultSettings.mergeOpenaiMaxTokens).toBe(0);
        expect(defaultSettings.mergeSummarizerResponseLength).toBe(0);
    });

    it('keeps the fallback connection disabled by default', () => {
        expect(defaultSettings.fallbackConnectionSource).toBe('disabled');
        expect(defaultSettings.fallbackConnectionProfileId).toBe('');
        expect(defaultSettings.fallbackOllamaModel).toBe('');
        expect(defaultSettings.fallbackOpenaiModel).toBe('');
        expect(defaultSettings.fallbackOpenaiMaxTokens).toBe(0);
        expect(defaultSettings.fallbackSummarizerResponseLength).toBe(0);
    });
});
