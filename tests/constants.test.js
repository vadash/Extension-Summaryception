import { describe, it, expect } from 'vitest';
import {
    MODULE_NAME,
    LOG_PREFIX,
    defaultSettings,
    PROMPT_PRESETS,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    DEFAULT_PROMPT_PRESET,
    DEFAULT_PROMOTION_PROMPT_PRESET,
    RETRY_CONFIG,
    UI_MODES,
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
        expect(defaultSettings.uiMode).toBe(UI_MODES.EASY);
        expect(defaultSettings.easySummarizerContextTokens).toBe(16000);
        expect(defaultSettings.easyMemoryTokenBudget).toBe(10000);
        expect(defaultSettings.easyMemoryMode).toBe('standard');
        expect(defaultSettings.easyConnectionSource).toBe('default');
        expect(defaultSettings.easyMergeConnectionSource).toBe('inherit');
        expect(defaultSettings.customMemoryPosition).toBe('in_prompt');
        expect(defaultSettings.customMemoryRole).toBe('system');
        expect(defaultSettings.customMemoryDepth).toBe(0);
        expect(defaultSettings.minSummaryTurns).toBe(3);
        expect(defaultSettings.maxSummaryTurns).toBe(8);
        expect(defaultSettings.layer0SummaryTokenTarget).toBe(200);
        expect(defaultSettings.maxL0SourceTokens).toBe(16000);
        expect(defaultSettings.maxSummaryTurns).toBeGreaterThanOrEqual(
            defaultSettings.minSummaryTurns,
        );
        expect(defaultSettings.minSummaryBudget).toBe(8000);
        expect(defaultSettings.verbatimTokenBudget).toBe(16000);
        expect(defaultSettings.memoryTokenBudget).toBe(10000);
        expect(defaultSettings.snippetsPerLayer).toBe(24);
        expect(defaultSettings.snippetsPerPromotion).toBe(3);
        expect(defaultSettings.snippetsPerLayer).toBeGreaterThan(
            defaultSettings.snippetsPerPromotion,
        );
        expect(defaultSettings.promptInputLogMode).toBe(false);
        expect(defaultSettings.promptOutputLogMode).toBe(false);
        expect(defaultSettings.stripChineseIdeographs).toBe(true);
    });

    it('uses the Summaryception memory wrapper by default', () => {
        expect(defaultSettings.injectionTemplate).toContain('<summaryception_memory>');
        expect(defaultSettings.injectionTemplate).toContain('[HIERARCHY OF TRUTH]');
        expect(defaultSettings.injectionTemplate).toContain('[CURRENT STATE]');
        expect(defaultSettings.injectionTemplate).toContain('[CHRONOLOGY]');
        expect(defaultSettings.injectionTemplate).toContain('strict priority');
        expect(defaultSettings.injectionTemplate).toContain('[msgs X-Y; current T]');
        expect(defaultSettings.injectionTemplate).toContain('scene time at the end of message Y');
        expect(defaultSettings.injectionTemplate).toContain('{{summary}}');
    });

    it('configures exponential-backoff retry within 2s..60s bounds', () => {
        expect(RETRY_CONFIG.maxRetries).toBe(3);
        expect(RETRY_CONFIG.baseDelay).toBeLessThanOrEqual(RETRY_CONFIG.maxDelay);
        expect(RETRY_CONFIG.maxDelay).toBe(60000);
        expect(RETRY_CONFIG.backoffMultiplier).toBeGreaterThan(1);
    });

    it('declares retryable HTTP statuses for transient failures', () => {
        expect(RETRY_CONFIG.retryableStatuses).toEqual([429, 500, 502, 503, 504]);
    });

    it('exposes every documented prompt preset', () => {
        expect(Object.keys(SUMMARIZER_SYSTEM_PROMPT_PRESETS).sort()).toEqual([
            'custom',
            'narrative',
        ]);
        expect(SUMMARIZER_SYSTEM_PROMPT_PRESETS.custom).toBeNull();
        expect(SUMMARIZER_SYSTEM_PROMPT_PRESETS.narrative).toContain(
            'narrative-state dual compressor',
        );
        expect(Object.keys(PROMPT_PRESETS).sort()).toEqual(['custom', 'narrative']);
        expect(PROMPT_PRESETS.custom).toBeNull();
        expect(PROMPT_PRESETS.narrative).toContain('{{story_txt}}');
        expect(PROMPT_PRESETS.narrative).toContain('[NARRATIVE]');
        expect(PROMPT_PRESETS.narrative).toContain('[STATE]');
        expect(PROMPT_PRESETS.narrative).not.toContain('about 150 tokens');
        expect(PROMPT_PRESETS.narrative).toContain('CHANGED or became newly relevant');
        expect(PROMPT_PRESETS.narrative).toContain('current_date_time');
        expect(PROMPT_PRESETS.narrative).toContain('YYYY-MM-DD HH ddd');
        expect(PROMPT_PRESETS.narrative).toContain('physiological or sex counters');
        expect(PROMPT_PRESETS.narrative).toContain('static character background/profile facts');
        expect(Object.keys(SUMMARIZER_REPAIR_PROMPT_PRESETS).sort()).toEqual([
            'custom',
            'narrative',
        ]);
        expect(SUMMARIZER_REPAIR_PROMPT_PRESETS.custom).toBeNull();
        expect(SUMMARIZER_REPAIR_PROMPT_PRESETS.narrative).toContain(
            'previous Layer 0 summary attempt failed',
        );
        expect(SUMMARIZER_REPAIR_PROMPT_PRESETS.narrative).toContain('[STATE]');
    });

    it('exposes every documented promotion prompt preset', () => {
        expect(Object.keys(PROMOTION_SYSTEM_PROMPT_PRESETS).sort()).toEqual([
            'custom',
            'narrative',
        ]);
        expect(PROMOTION_SYSTEM_PROMPT_PRESETS.custom).toBeNull();
        expect(PROMOTION_SYSTEM_PROMPT_PRESETS.narrative).toContain(
            'prose-folding memory synthesizer',
        );
        expect(Object.keys(PROMOTION_PROMPT_PRESETS).sort()).toEqual(['custom', 'narrative']);
        expect(PROMOTION_PROMPT_PRESETS.custom).toBeNull();
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('{{context_str}}');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('{{story_txt}}');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('{{source_state}}');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('narratives_to_consolidate');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('PROSE-FOLDING RULES');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('Do not output a [STATE] block');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('Fold any still-durable facts');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain(
            '[msgs 100-120; current 2024-12-03 09 Wed]',
        );
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('physiological or sex counters');
        expect(PROMOTION_PROMPT_PRESETS.narrative).toContain('Omit stale transient scene facts');
        expect(Object.keys(PROMOTION_REPAIR_PROMPT_PRESETS).sort()).toEqual([
            'custom',
            'narrative',
        ]);
        expect(PROMOTION_REPAIR_PROMPT_PRESETS.custom).toBeNull();
        expect(PROMOTION_REPAIR_PROMPT_PRESETS.narrative).toContain(
            'previous Layer 1+ promotion draft',
        );
        expect(PROMOTION_REPAIR_PROMPT_PRESETS.narrative).toContain('{{source_state}}');
    });

    it('defaults to the narrative preset', () => {
        expect(DEFAULT_PROMPT_PRESET).toBe('narrative');
        expect(defaultSettings.summarizerSystemPromptPreset).toBe(DEFAULT_PROMPT_PRESET);
        expect(defaultSettings.summarizerSystemPrompt).toBe(
            SUMMARIZER_SYSTEM_PROMPT_PRESETS.narrative,
        );
        expect(defaultSettings.promptPreset).toBe(DEFAULT_PROMPT_PRESET);
        expect(defaultSettings.summarizerUserPrompt).toBe(PROMPT_PRESETS.narrative);
        expect(defaultSettings.summarizerRepairPromptPreset).toBe(DEFAULT_PROMPT_PRESET);
        expect(defaultSettings.summarizerRepairPrompt).toBe(
            SUMMARIZER_REPAIR_PROMPT_PRESETS.narrative,
        );
        expect(DEFAULT_PROMOTION_PROMPT_PRESET).toBe('narrative');
        expect(defaultSettings.promotionSystemPromptPreset).toBe(DEFAULT_PROMOTION_PROMPT_PRESET);
        expect(defaultSettings.promotionSystemPrompt).toBe(
            PROMOTION_SYSTEM_PROMPT_PRESETS.narrative,
        );
        expect(defaultSettings.promotionPromptPreset).toBe(DEFAULT_PROMOTION_PROMPT_PRESET);
        expect(defaultSettings.promotionUserPrompt).toBe(PROMOTION_PROMPT_PRESETS.narrative);
        expect(defaultSettings.promotionRepairPromptPreset).toBe(DEFAULT_PROMOTION_PROMPT_PRESET);
        expect(defaultSettings.promotionRepairPrompt).toBe(
            PROMOTION_REPAIR_PROMPT_PRESETS.narrative,
        );
    });

    it('provides separate Layer 1+ promotion prompts', () => {
        expect(defaultSettings.promotionSystemPrompt).toContain('prose-folding memory synthesizer');
        expect(defaultSettings.promotionUserPrompt).toContain('{{context_str}}');
        expect(defaultSettings.promotionUserPrompt).toContain('{{story_txt}}');
        expect(defaultSettings.promotionUserPrompt).toContain('{{source_state}}');
        expect(defaultSettings.promotionUserPrompt).toContain('narratives_to_consolidate');
        expect(defaultSettings.promotionUserPrompt).toContain('immutable baseline history');
        expect(defaultSettings.promotionUserPrompt).toContain('Strict Delta Scoping');
        expect(defaultSettings.promotionUserPrompt).toContain('Temporal Anchors');
        expect(defaultSettings.promotionUserPrompt).toContain(
            '[msgs 100-120; current 2024-12-03 09 Wed]',
        );
        expect(defaultSettings.promotionUserPrompt).toContain('hour-level 24-hour timestamps');
        expect(defaultSettings.promotionUserPrompt).toContain('PROSE-FOLDING RULES');
        expect(defaultSettings.promotionUserPrompt).toContain('Omit stale transient scene facts');
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
