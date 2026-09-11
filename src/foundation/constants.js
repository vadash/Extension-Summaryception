import {
    DEFAULT_INJECTION_TEMPLATE,
    DEFAULT_PROMOTION_REPAIR_PROMPT,
    DEFAULT_PROMOTION_SYSTEM_PROMPT,
    DEFAULT_PROMOTION_USER_PROMPT,
    DEFAULT_SUMMARIZER_REPAIR_PROMPT,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_USER_PROMPT,
} from './prompt-constants.js';

export { RECALL_REPEAT_INJECTION_TEMPLATE } from './prompt-constants.js';

export const MODULE_NAME = 'summaryception';
export const LOG_PREFIX = '[Summaryception]';
export const TOAST_TITLE = 'Summaryception';

export const MEMORY_MODES = Object.freeze({
    BALANCED: 'balanced',
    PREFIX_CACHE: 'prefix_cache',
    CUSTOM: 'custom',
});
export const MEMORY_MODE_PRESETS = Object.freeze({
    [MEMORY_MODES.BALANCED]: Object.freeze({
        verbatimTokenBudget: 22000,
        queuedTokenBudget: 6000,
    }),
    [MEMORY_MODES.PREFIX_CACHE]: Object.freeze({
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
    }),
});

/**
 * Selectable memory modes that own an initial retention preset.
 * `custom` is intentionally excluded: it carries no preset.
 * @type {ReadonlyArray<string>}
 */
const SELECTABLE_MEMORY_MODES = Object.freeze([MEMORY_MODES.BALANCED, MEMORY_MODES.PREFIX_CACHE]);

/**
 * Apply a mode's initial retention preset to settings.
 * Every actual mode transition intentionally overwrites the recent and queued budgets (and the Append Only baked cap)
 * with the destination preset. Reselecting the already-active mode is a no-op,
 * and an invalid mode leaves settings untouched.
 * @param {ExtensionSettings} settings
 * @param {string} mode
 * @returns {boolean} true when settings were mutated, false otherwise.
 */
export function applyMemoryModePreset(settings, mode) {
    if (!SELECTABLE_MEMORY_MODES.includes(String(mode))) {
        return false;
    }
    if (settings.memoryMode === mode) {
        return false;
    }
    const preset = MEMORY_MODE_PRESETS[mode];
    settings.memoryMode = mode;
    settings.verbatimTokenBudget = preset.verbatimTokenBudget;
    settings.queuedTokenBudget = preset.queuedTokenBudget;
    return true;
}

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

// ─── Layer Presentation ──────────────────────────────────────────────

/**
 * Human-facing label for a summary layer.
 * @param {number} index - Zero-based layer index
 * @returns {string}
 */
export function layerLabel(index) {
    return index === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${index} (Meta-Summary)`;
}

/**
 * List the store's non-empty summary layers, deepest first.
 * @param {SummaryceptionStore} store
 * @returns {Array<{ index: number, layer: SummaryceptionSnippet[] }>}
 */
export function listNonEmptyLayers(store) {
    const sourceLayers = Array.isArray(store?.layers) ? store.layers : [];
    const result = [];
    for (let i = sourceLayers.length - 1; i >= 0; i--) {
        const layer = sourceLayers[i];
        if (layer?.length > 0) {
            result.push({ index: i, layer });
        }
    }
    return result;
}

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

// ─── Provider Cache TTL ─────────────────────────────────────────────
// Minutes a provider keeps a cached prompt prefix alive in Prefix Cache mode.
// Stored on settings as cacheTtlMinutes. Older chats make
// the cache stale; the stale-cache advisor uses this to suggest an early
// Force Summarize on chat load.
export const CACHE_TTL = Object.freeze({
    MIN_MINUTES: 5,
    MAX_MINUTES: 240,
    STEP_MINUTES: 5,
    DEFAULT_MINUTES: 30,
});
// ─── Default Settings ────────────────────────────────────────────────

export const defaultSettings = Object.freeze({
    enabled: true,
    // Latched by Stop; blocks only automatic cycles. Manual runs ignore it.
    autoPaused: false,
    memoryMode: MEMORY_MODES.BALANCED,
    cacheTtlMinutes: CACHE_TTL.DEFAULT_MINUTES, // provider cache lifetime, Prefix Cache only
    // Decoupled from uiMode: which complexity panel (Easy/Advanced) to render,
    // shown even when the extension is off so config stays editable.
    configMode: UI_MODES.EASY,
    uiMode: UI_MODES.EASY,
    customMemoryPosition: MEMORY_POSITIONS.IN_PROMPT,
    customMemoryRole: MEMORY_ROLES.SYSTEM,
    customMemoryDepth: 0,
    injectCurrentState: false, // false = omit the [CURRENT STATE] block from injected memory
    // ─── Modular STATE categories (stateCat*) ─────────────────────────
    // Most categories ship enabled: the extension's [CURRENT STATE] injection
    // is meant to be the sole carrier, so users should disable the equivalent
    // blocks in their RP preset. stateCatDateTime is informational only;
    // alwaysOn forces true at runtime regardless of this flag. Chekhov ships
    // off: it needs matching FIRE-decision logic in the preset CoT to be useful.
    stateCatDateTime: true,
    stateCatBonds: true,
    stateCatChekhov: false,
    stateCatGmNotes: true,
    stateCatInventory: true,
    stateCatLocation: true,
    minSummaryTurns: 3,
    maxSummaryTurns: 8,
    layer0SummaryTokenTarget: 280,
    maxL0SourceTokens: 24000,
    advancedModelContext: 48000,
    minSummaryBudget: 16000,
    verbatimTokenBudget: 22000,
    queuedTokenBudget: 6000,
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
    // true = also hide text-less messages (images, tool calls) inside the summarized
    // range. They carry no text to summarize, so without this they stay visible to the
    // model and leave gaps in the hidden range that still cost context.
    hideNonTextMessages: true,
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
    connectionSource: 'default', // 'default' | 'profile'
    summarizerResponseLength: 0, // 0 = provider/profile default
    connectionProfileId: '', // ID of selected ST Connection Profile
    requestTimeoutSeconds: REQUEST_TIMEOUT.DEFAULT_SECONDS, // Layer 0 / regenerate, in seconds

    // Optional Layer 1+ promotion merge connection. 'inherit' uses the Layer 0 connection above.
    mergeConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile'
    mergeSummarizerResponseLength: 0,
    mergeConnectionProfileId: '',
    mergeRequestTimeoutSeconds: REQUEST_TIMEOUT.MERGE_DEFAULT_SECONDS, // L1+ promotions, in seconds

    // Optional fallback connection used after the primary route exhausts retryable failures.
    fallbackConnectionSource: 'disabled', // 'disabled' | 'default' | 'profile'
    fallbackSummarizerResponseLength: 0,
    fallbackConnectionProfileId: '',
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

/**
 * The six (presetKey, settingKey) prompt pairs shared by persistence
 * normalization and the prompt UI bindings. Order defines UI field order.
 * @type {ReadonlyArray<{ presetKey: string, settingKey: string }>}
 */
export const PROMPT_SETTING_KEYS = Object.freeze([
    Object.freeze({
        presetKey: 'summarizerSystemPromptPreset',
        settingKey: 'summarizerSystemPrompt',
    }),
    Object.freeze({ presetKey: 'promptPreset', settingKey: 'summarizerUserPrompt' }),
    Object.freeze({
        presetKey: 'summarizerRepairPromptPreset',
        settingKey: 'summarizerRepairPrompt',
    }),
    Object.freeze({
        presetKey: 'promotionSystemPromptPreset',
        settingKey: 'promotionSystemPrompt',
    }),
    Object.freeze({ presetKey: 'promotionPromptPreset', settingKey: 'promotionUserPrompt' }),
    Object.freeze({
        presetKey: 'promotionRepairPromptPreset',
        settingKey: 'promotionRepairPrompt',
    }),
]);

// ─── Retry Configuration ─────────────────────────────────────────────

export const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};
