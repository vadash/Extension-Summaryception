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

export const UI_MODES = Object.freeze({
    OFF: 'off',
    EASY: 'easy',
    ADVANCED: 'advanced',
});

export const EASY_CONTEXT_LIMITS = Object.freeze({
    MIN: 8000,
    MAX: 64000,
    STEP: 1000,
});

export const EASY_MEMORY_LIMITS = Object.freeze({
    MIN: 4000,
    MAX: 16000,
    STEP: 1000,
});

export const L0_SOURCE_LIMITS = Object.freeze({
    MIN: 8000,
    MAX: 64000,
    STEP: 1000,
});

export const BATCH_TRIGGER_LIMITS = Object.freeze({
    MIN: 4000,
    MAX: 32000,
    STEP: 1000,
});

export const MASK_USER_ROLE_MODES = Object.freeze({
    MARKER_FIRST: 'marker_first',
    REWRITE_ALL: 'rewrite_all',
    MARKER_LAST: 'marker_last',
    KEEP_LAST_USER: 'keep_last_user',
});

export const MEMORY_POSITIONS = Object.freeze({
    BEFORE_PROMPT: 'before_prompt',
    IN_PROMPT: 'in_prompt',
    IN_CHAT: 'in_chat',
    MACRO_ONLY: 'macro_only',
});

export const MEMORY_ROLES = Object.freeze({
    SYSTEM: 'system',
    USER: 'user',
    ASSISTANT: 'assistant',
});

export const EXTENSION_PROMPT_POSITIONS = Object.freeze({
    NONE: -1,
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

// ─── Request Timeout Configuration ─────────────────────────────────
// Per-route summarizer request timeouts in seconds. Stored on settings as
// requestTimeoutSeconds / mergeRequestTimeoutSeconds / fallbackRequestTimeoutSeconds.
// The policy converts to milliseconds; the retry attempt runs at 75% of the first.
export const REQUEST_TIMEOUT = Object.freeze({
    MIN_SECONDS: 60,
    MAX_SECONDS: 300,
    STEP_SECONDS: 10,
    DEFAULT_SECONDS: 120, // Layer 0 / regenerate / fallback
    MERGE_DEFAULT_SECONDS: 90, // L1+ promotions (smaller payloads)
    RETRY_ATTEMPT_RATIO: 0.75,
});
// ─── Default Settings ────────────────────────────────────────────────

export const defaultSettings = Object.freeze({
    enabled: true,
    uiMode: UI_MODES.EASY,
    easySummarizerContextTokens: 16000,
    easyMemoryTokenBudget: 10000,
    easyMemoryMode: MEMORY_MODES.STANDARD,
    easyConnectionSource: 'default', // 'default' | 'profile'
    easyConnectionProfileId: '',
    easyMergeConnectionSource: 'inherit', // 'inherit' | 'profile'
    easyMergeConnectionProfileId: '',
    memoryMode: MEMORY_MODES.STANDARD,
    customMemoryPosition: MEMORY_POSITIONS.IN_PROMPT,
    customMemoryRole: MEMORY_ROLES.SYSTEM,
    customMemoryDepth: 0,
    minSummaryTurns: 3,
    maxSummaryTurns: 8,
    layer0SummaryTokenTarget: 200,
    maxL0SourceTokens: 24000,
    advancedModelContext: 48000,
    minSummaryBudget: 16000,
    verbatimTokenBudget: 22000,
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
    maskUserRoleAsAssistant: false, // true = rewrite outgoing user-role request blocks as assistant
    maskUserRoleMode: MASK_USER_ROLE_MODES.MARKER_FIRST,

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
    summarizerResponseLength: 0, // 0 = provider/profile default
    connectionProfileId: '', // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [], // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0, // 0 = provider default
    requestTimeoutSeconds: REQUEST_TIMEOUT.DEFAULT_SECONDS, // Layer 0 / regenerate, in seconds

    // Optional Layer 1+ promotion merge connection. 'inherit' uses the Layer 0 connection above.
    mergeConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile' | 'ollama' | 'openai'
    mergeSummarizerResponseLength: 0,
    mergeConnectionProfileId: '',
    mergeOllamaModel: '',
    mergeOpenaiModel: '',
    mergeOpenaiMaxTokens: 0,
    mergeRequestTimeoutSeconds: REQUEST_TIMEOUT.MERGE_DEFAULT_SECONDS, // L1+ promotions, in seconds

    // Optional fallback connection used after the primary route exhausts retryable failures.
    fallbackConnectionSource: 'disabled', // 'disabled' | 'default' | 'profile' | 'ollama' | 'openai'
    fallbackSummarizerResponseLength: 0,
    fallbackConnectionProfileId: '',
    fallbackOllamaModel: '',
    fallbackOpenaiModel: '',
    fallbackOpenaiMaxTokens: 0,
    fallbackRequestTimeoutSeconds: REQUEST_TIMEOUT.DEFAULT_SECONDS, // fallback route, in seconds
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
