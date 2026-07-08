import {
    DEFAULT_INJECTION_TEMPLATE,
    DEFAULT_PROMOTION_REPAIR_PROMPT,
    DEFAULT_PROMOTION_SYSTEM_PROMPT,
    DEFAULT_PROMOTION_USER_PROMPT,
    DEFAULT_SUMMARIZER_REPAIR_PROMPT,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_USER_PROMPT,
} from './prompt-constants.js';

export const MODULE_NAME = 'summaryception';
export const LOG_PREFIX = '[Summaryception]';

export const MEMORY_MODES = Object.freeze({
    STANDARD: 'standard',
    CACHE: 'cache',
    CUSTOM: 'custom',
});

export const MEMORY_POSITIONS = Object.freeze({
    BEFORE_PROMPT: 'before_prompt',
    IN_PROMPT: 'in_prompt',
    IN_CHAT: 'in_chat',
});

export const MEMORY_ROLES = Object.freeze({
    SYSTEM: 'system',
    USER: 'user',
    ASSISTANT: 'assistant',
});

export const EXTENSION_PROMPT_POSITIONS = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

export const EXTENSION_PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

export const INTERNAL_MAX_LAYER_DEPTH = 20;

// ─── Default Settings ────────────────────────────────────────────────

export const defaultSettings = Object.freeze({
    enabled: true,
    memoryMode: MEMORY_MODES.STANDARD,
    customMemoryPosition: MEMORY_POSITIONS.IN_PROMPT,
    customMemoryRole: MEMORY_ROLES.SYSTEM,
    customMemoryDepth: 0,
    minSummaryTurns: 3,
    maxSummaryTurns: 8,
    layer0SummaryTokenTarget: 200,
    minSummaryBudget: 8000,
    verbatimTokenBudget: 16000,
    memoryTokenBudget: 10000,
    snippetsPerLayer: 24,
    snippetsPerPromotion: 3,
    injectionTemplate: DEFAULT_INJECTION_TEMPLATE,
    summarizerSystemPrompt: DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    summarizerUserPrompt: DEFAULT_SUMMARIZER_USER_PROMPT,
    summarizerRepairPrompt: DEFAULT_SUMMARIZER_REPAIR_PROMPT,
    promotionSystemPrompt: DEFAULT_PROMOTION_SYSTEM_PROMPT,
    promotionUserPrompt: DEFAULT_PROMOTION_USER_PROMPT,
    promotionRepairPrompt: DEFAULT_PROMOTION_REPAIR_PROMPT,

    summarizerSystemPromptPreset: 'narrative', // 'narrative' | 'custom'
    promptPreset: 'narrative', // 'narrative' | 'custom'
    summarizerRepairPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionSystemPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionRepairPromptPreset: 'narrative', // 'narrative' | 'custom'
    applyRegexScripts: true, // true = apply ST's regex scripts to passage text before summarizing
    stripChineseIdeographs: true, // true = strip Han ideographs from summarizer responses

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    debugMode: false,
    traceMode: false,
    promptInputLogMode: false,
    promptOutputLogMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default', // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0, // 0 = Layer 0 target plus safety buffer at runtime
    connectionProfileId: '', // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [], // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0, // 0 = Layer 0 target plus safety buffer at runtime

    // Optional Layer 1+ promotion merge connection. 'inherit' uses the Layer 0 connection above.
    mergeConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile' | 'ollama' | 'openai'
    mergeSummarizerResponseLength: 0,
    mergeConnectionProfileId: '',
    mergeOllamaModel: '',
    mergeOpenaiModel: '',
    mergeOpenaiMaxTokens: 0,

    // Optional fallback connection used after the primary route exhausts retryable failures.
    fallbackConnectionSource: 'disabled', // 'disabled' | 'default' | 'profile' | 'ollama' | 'openai'
    fallbackSummarizerResponseLength: 0,
    fallbackConnectionProfileId: '',
    fallbackOllamaModel: '',
    fallbackOpenaiModel: '',
    fallbackOpenaiMaxTokens: 0,
});

// ─── Prompt Presets ──────────────────────────────────────────────────

export const PROMPT_PRESETS = {
    narrative: defaultSettings.summarizerUserPrompt,
    custom: null, // Uses whatever is in the textarea
};

export const SUMMARIZER_SYSTEM_PROMPT_PRESETS = {
    narrative: defaultSettings.summarizerSystemPrompt,
    custom: null,
};

export const SUMMARIZER_REPAIR_PROMPT_PRESETS = {
    narrative: defaultSettings.summarizerRepairPrompt,
    custom: null,
};

export const PROMOTION_PROMPT_PRESETS = {
    narrative: defaultSettings.promotionUserPrompt,
    custom: null, // Uses whatever is in the textarea
};

export const PROMOTION_SYSTEM_PROMPT_PRESETS = {
    narrative: defaultSettings.promotionSystemPrompt,
    custom: null,
};

export const PROMOTION_REPAIR_PROMPT_PRESETS = {
    narrative: defaultSettings.promotionRepairPrompt,
    custom: null,
};

export const DEFAULT_PROMPT_PRESET = 'narrative';
export const DEFAULT_PROMOTION_PROMPT_PRESET = 'narrative';

// ─── Retry Configuration ─────────────────────────────────────────────

export const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};
