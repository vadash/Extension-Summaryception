import {
    DEFAULT_AUDITOR_SYSTEM_PROMPT,
    DEFAULT_AUDITOR_USER_PROMPT,
    DEFAULT_INJECTION_TEMPLATE,
    DEFAULT_PROMOTION_REPAIR_PROMPT,
    DEFAULT_PROMOTION_SYSTEM_PROMPT,
    DEFAULT_PROMOTION_USER_PROMPT,
    DEFAULT_SUMMARIZER_REPAIR_PROMPT,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    DEFAULT_SUMMARIZER_USER_PROMPT,
    LAYER0_RECALL_BODY,
    PROMOTION_RECALL_BODY,
} from './prompt-constants.js';

export { RECALL_REPEAT_INJECTION_TEMPLATE } from './prompt-constants.js';

export const MODULE_NAME = 'summaryception';
export const LOG_PREFIX = '[Summaryception]';
export const TOAST_TITLE = 'Summaryception';

/**
 * Stable ghosting progress labels and terminal clear kinds emitted on the
 * notify adapter (ADR-0019); the entry adapter maps them to on-screen text.
 * Core carries these ids, never prose.
 * @type {{ HIDE: string, UNHIDE: string, UNHIDDEN: string }}
 */
export const GHOST_PROGRESS = Object.freeze({
    HIDE: 'ghost-hide',
    UNHIDE: 'ghost-unhide',
    UNHIDDEN: 'ghost-unhidden',
});

/**
 * Stable batch progress label and terminal clear kinds emitted on the notify
 * adapter (ADR-0019); the entry adapter maps them to on-screen text. Core
 * carries these ids, never prose.
 * @type {{ MEMORY: string, UPDATED: string, ABORTED: string, FAILED: string }}
 */
export const BATCH_PROGRESS = Object.freeze({
    MEMORY: 'batch-memory',
    UPDATED: 'batch-memory-updated',
    ABORTED: 'batch-memory-aborted',
    FAILED: 'batch-memory-failed',
});

/**
 * Stable transient event kinds emitted on the notify adapter (ADR-0019); the
 * entry adapter maps each kind to a user notice. Core carries these ids, never
 * prose.
 * @type {{ RUN_ABORTED: string, RUN_FAILED: string, EASY_GUARD_BLOCKED: string, MICROFICHE_READER_BLOCKED: string, MICROFICHE_GEOMETRY_BLOCKED: string, RETRY_WAIT: string, ROUTE_CYCLE_WAIT: string, LANGUAGE_MIX_RETRY: string, PROMOTION_STARTED: string }}
 */
export const NOTIFY_EVENTS = Object.freeze({
    RUN_ABORTED: 'run-aborted',
    RUN_FAILED: 'run-failed',
    EASY_GUARD_BLOCKED: 'easy-guard-blocked',
    MICROFICHE_READER_BLOCKED: 'microfiche-reader-blocked',
    MICROFICHE_GEOMETRY_BLOCKED: 'microfiche-geometry-blocked',
    RETRY_WAIT: 'retry-wait',
    ROUTE_CYCLE_WAIT: 'route-cycle-wait',
    LANGUAGE_MIX_RETRY: 'language-mix-retry',
    PROMOTION_STARTED: 'promotion-started',
});

export const MEMORY_MODES = Object.freeze({
    BALANCED: 'balanced',
    PREFIX_CACHE: 'prefix_cache',
    MICROFICHE: 'microfiche',
    CUSTOM: 'custom',
});
// Unknown modes fall back to the standard route: only presets with atomicPartitions take the atomic path.
export const MEMORY_MODE_PRESETS = Object.freeze({
    [MEMORY_MODES.BALANCED]: Object.freeze({
        verbatimTokenBudget: 22000,
        queuedTokenBudget: 6000,
        atomicPartitions: false,
    }),
    [MEMORY_MODES.PREFIX_CACHE]: Object.freeze({
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
        atomicPartitions: true,
    }),
    // Microfiche renders the same retained context as images, so it keeps the
    // Prefix Cache budgets; switching modes changes the render path only, never retention.
    [MEMORY_MODES.MICROFICHE]: Object.freeze({
        verbatimTokenBudget: 20000,
        queuedTokenBudget: 16000,
        atomicPartitions: true,
    }),
});

/**
 * Selectable memory modes that own an initial retention preset.
 * `custom` is intentionally excluded: it carries no preset.
 * @type {ReadonlyArray<string>}
 */
export const SELECTABLE_MEMORY_MODES = Object.freeze([
    MEMORY_MODES.BALANCED,
    MEMORY_MODES.PREFIX_CACHE,
    MEMORY_MODES.MICROFICHE,
]);

/**
 * Apply a mode's initial retention preset to settings. Every mode transition
 * overwrites the recent and queued budgets with the destination preset.
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
    settings.atomicPartitions = preset.atomicPartitions;
    return true;
}
/**
 * Stamp a Microfiche geometry preset into the explicit render knobs. A named
 * preset overwrites the explicit geometry with the preset shape, so custom
 * keeps the current values and only flips the selector.
 * @param {ExtensionSettings} settings
 * @param {string} name
 * @returns {boolean} true when settings were mutated, false otherwise.
 */
export function applyMicroficheGeometryPreset(settings, name) {
    const key = String(name);
    if (!MICROFICHE_GEOMETRY_NAMES.includes(key)) {
        return false;
    }
    if (key === 'custom') {
        if (settings.microficheGeometry === 'custom') {
            return false;
        }
        settings.microficheGeometry = 'custom';
        return true;
    }
    const preset =
        /** @type {{ font: string, cellWidth: number, cellHeight: number, variant: string, stopwordDim: boolean, columns: number, lineRepeat: number, frameSize: number }} */ (
            MICROFICHE_GEOMETRY_PRESETS[/** @type {'anthropic'|'google'|'openai'} */ (key)]
        );
    let changed = settings.microficheGeometry !== key;
    changed = stampMicroficheGeometryValues(settings, preset) || changed;
    settings.microficheGeometry = /** @type {'anthropic'|'google'|'openai'|'custom'} */ (key);
    return changed;
}

/**
 * Load a catalogue shape as the custom starting point. The shape values land
 * in the explicit knobs and the selector flips to custom for hand-tuning.
 * @param {ExtensionSettings} settings
 * @param {string} preset
 * @returns {boolean} true when settings were mutated, false otherwise.
 */
export function applyMicroficheShapeAsCustom(settings, preset) {
    const shape = MICROFICHE_SHAPES.find((candidate) => candidate.preset === preset);
    if (!shape) {
        return false;
    }
    let changed = settings.microficheGeometry !== 'custom';
    changed =
        stampMicroficheGeometryValues(settings, MICROFICHE_GEOMETRY_PRESETS[shape.preset]) ||
        changed;
    settings.microficheGeometry = 'custom';
    return changed;
}

/**
 * Copy one geometry preset's render knobs into the explicit settings keys.
 * @param {ExtensionSettings} settings
 * @param {{ font: string, cellWidth: number, cellHeight: number, variant: string, stopwordDim: boolean, columns: number, lineRepeat: number, frameSize: number }} preset
 * @returns {boolean} true when a knob changed.
 */
function stampMicroficheGeometryValues(settings, preset) {
    const next = {
        microficheFont: preset.font,
        microficheCellWidth: preset.cellWidth,
        microficheCellHeight: preset.cellHeight,
        microficheVariant: preset.variant,
        microficheStopwordDim: preset.stopwordDim,
        microficheColumns: preset.columns,
        microficheLineRepeat: preset.lineRepeat,
        microficheFrameSize: preset.frameSize,
    };
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
        if (settings[key] !== value) {
            settings[key] = value;
            changed = true;
        }
    }
    return changed;
}
/**
 * Microfiche geometry catalogue: named family render shapes with the host
 * readers that can serve them. The finder list mirrors the presets so the
 * model-name lookup can suggest a starting shape; `custom` unlocks explicit
 * geometry.
 */
export const MICROFICHE_FONTS = Object.freeze(['5x8', '8x8', '6x12', '8x13']);
export const MICROFICHE_VARIANTS = Object.freeze(['bw', 'sent']);
export const MICROFICHE_GEOMETRY_NAMES = Object.freeze(['anthropic', 'google', 'openai', 'custom']);
export const MICROFICHE_GEOMETRY_PRESETS = Object.freeze({
    anthropic: Object.freeze({
        font: '8x13',
        cellWidth: 11,
        cellHeight: 16,
        variant: 'bw',
        stopwordDim: false,
        columns: 1,
        lineRepeat: 1,
        frameSize: 1568,
        frameTokenEstimate: 3136,
        imageBudget: 5,
        readers: Object.freeze(['anthropic']),
    }),
    google: Object.freeze({
        font: '8x13',
        cellWidth: 8,
        cellHeight: 22,
        variant: 'bw',
        stopwordDim: false,
        columns: 1,
        lineRepeat: 1,
        frameSize: 1568,
        frameTokenEstimate: 1120,
        imageBudget: 200,
        readers: Object.freeze(['google']),
    }),
    openai: Object.freeze({
        font: '8x13',
        cellWidth: 8,
        cellHeight: 22,
        variant: 'bw',
        stopwordDim: false,
        columns: 1,
        lineRepeat: 1,
        frameSize: 1568,
        frameTokenEstimate: 994,
        readers: Object.freeze(['openai']),
    }),
    custom: null,
});
function microficheShape(id, label, preset, match) {
    return Object.freeze({
        id,
        label,
        preset,
        match: Object.freeze(match),
        ...MICROFICHE_GEOMETRY_PRESETS[preset],
    });
}
export const MICROFICHE_SHAPES = Object.freeze([
    microficheShape('anthropic', 'Anthropic', 'anthropic', ['anthropic', 'claude', 'glm']),
    microficheShape('google', 'Google', 'google', ['google', 'gemini']),
    microficheShape('openai', 'OpenAI', 'openai', ['openai', 'gpt', 'deepseek']),
]);
/**
 * Suggest up to three shapes for a model name by case-insensitive substring
 * match over the shape id, label, preset, and family names. An empty query
 * returns every shape in preset order.
 * @param {unknown} query - Model-name text from the lookup box.
 * @returns {Array<object>} Up to three matching shapes, never the live catalogue.
 */
export function lookupModelShapes(query) {
    const needle = String(query ?? '')
        .trim()
        .toLowerCase();
    if (!needle) {
        return [...MICROFICHE_SHAPES];
    }
    return MICROFICHE_SHAPES.filter((shape) =>
        [shape.id, shape.label, shape.preset, ...shape.match].some((field) =>
            String(field).toLowerCase().includes(needle),
        ),
    ).slice(0, 3);
}

export const UI_MODES = Object.freeze({
    OFF: 'off',
    EASY: 'easy',
    ADVANCED: 'advanced',
});

/**
 * Operation Mode: whether the extension is On or Off. Off is the only state
 * that disables runtime behavior. Distinct from the Complexity Mode axis in
 * UI_MODES, which selects the visible panel.
 */
export const OPERATION_MODES = Object.freeze({
    ON: 'on',
    OFF: 'off',
});

/**
 * Slider and numeric-stepper bounds, keyed by setting id. Single source of
 * truth for numeric input bounds: the read-time normalizer is the only
 * enforcement, and the settings template's min/max/step attributes pin to
 * this map.
 * Bounds only: initial values live in defaultSettings. A `MAX` of null means
 * the input declares no upper bound.
 */
export const SLIDER_LIMITS = Object.freeze({
    advancedModelContext: Object.freeze({ MIN: 8000, MAX: 64000, STEP: 1000 }),
    maxL0SourceTokens: Object.freeze({ MIN: 8000, MAX: 64000, STEP: 1000 }),
    minSummaryBudget: Object.freeze({ MIN: 4000, MAX: 32000, STEP: 1000 }),
    verbatimTokenBudget: Object.freeze({ MIN: 4000, MAX: 64000, STEP: 1000 }),
    queuedTokenBudget: Object.freeze({ MIN: 4000, MAX: 64000, STEP: 1000 }),
    memoryTokenBudget: Object.freeze({ MIN: 4000, MAX: 32000, STEP: 1000 }),
    layer0SummaryTokenTarget: Object.freeze({ MIN: 80, MAX: 700, STEP: 10 }),
    minSummaryTurns: Object.freeze({ MIN: 2, MAX: 10, STEP: 1 }),
    maxSummaryTurns: Object.freeze({ MIN: 3, MAX: 20, STEP: 1 }),
    snippetsPerLayer: Object.freeze({ MIN: 20, MAX: 40, STEP: 1 }),
    snippetsPerPromotion: Object.freeze({ MIN: 3, MAX: 4, STEP: 1 }),
    cacheTtlMinutes: Object.freeze({ MIN: 5, MAX: 240, STEP: 5 }),
    requestTimeoutSeconds: Object.freeze({ MIN: 60, MAX: 7200, STEP: 10 }),
    mergeRequestTimeoutSeconds: Object.freeze({ MIN: 60, MAX: 7200, STEP: 10 }),
    fallbackRequestTimeoutSeconds: Object.freeze({ MIN: 60, MAX: 7200, STEP: 10 }),
    auditorRequestTimeoutSeconds: Object.freeze({ MIN: 60, MAX: 7200, STEP: 10 }),
    summarizerResponseLength: Object.freeze({ MIN: 0, MAX: null, STEP: 100 }),
    mergeSummarizerResponseLength: Object.freeze({ MIN: 0, MAX: null, STEP: 100 }),
    fallbackSummarizerResponseLength: Object.freeze({ MIN: 0, MAX: null, STEP: 100 }),
    auditorSummarizerResponseLength: Object.freeze({ MIN: 0, MAX: null, STEP: 100 }),
    customMemoryDepth: Object.freeze({ MIN: 0, MAX: 10000, STEP: 1 }),
    microficheKeepRaw: Object.freeze({ MIN: 0, MAX: 10, STEP: 1 }),
    microficheImageCap: Object.freeze({ MIN: 1, MAX: 80, STEP: 1 }),
    microficheCellWidth: Object.freeze({ MIN: 5, MAX: 16, STEP: 1 }),
    microficheCellHeight: Object.freeze({ MIN: 6, MAX: 22, STEP: 1 }),
    microficheLineRepeat: Object.freeze({ MIN: 1, MAX: 2, STEP: 1 }),
    microficheColumns: Object.freeze({ MIN: 1, MAX: 2, STEP: 1 }),
    microficheFrameSize: Object.freeze({ MIN: 512, MAX: 2608, STEP: 8 }),
    guardMaskCotCount: Object.freeze({ MIN: 1, MAX: 5, STEP: 1 }),
});

export const MASK_USER_ROLE_MODES = Object.freeze({
    MARKER_FIRST: 'marker_first',
    REWRITE_ALL: 'rewrite_all',
    MARKER_LAST: 'marker_last',
    KEEP_LAST_USER: 'keep_last_user',
});

/**
 * Guard Mask trailing Preset CoT exemption. Off masks the whole prompt; auto
 * uses a fixed two-message window; on uses the guardMaskCotCount slider.
 */
export const GUARD_MASK_COT_MODES = Object.freeze({
    OFF: 'off',
    AUTO: 'auto',
    ON: 'on',
});

/** Auto keeps a fixed two-message window, identical to on with this count. */
export const GUARD_MASK_COT_AUTO_COUNT = 2;

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
 * One shared helper serves the status panel, the snippet browser, and slash commands.
 * @param {number} index - Zero-based layer index
 * @returns {string}
 */
export function layerLabel(index) {
    return index === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${index} (Meta-Summary)`;
}

/**
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

// ─── Default Settings ────────────────────────────────────────────────

/**
 * Catch-up Window: one combined Auditor call covers at most this many
 * Exchanges (most recent first); it bounds coverage, never turn_count. The
 * injection slot reuses it to bound the depth shift a single catch-up causes.
 */
export const CATCHUP_WINDOW_EXCHANGES = 4;

export const defaultSettings = Object.freeze({
    enabled: true,
    // Latched by Stop; blocks only automatic cycles. Manual runs ignore it.
    autoPaused: false,
    // Opt-in Continuity Auditor (issue #28); off until the user enables it.
    continuityEnabled: false,
    memoryMode: MEMORY_MODES.BALANCED,
    cacheTtlMinutes: 30, // provider cache lifetime, Prefix Cache only
    // Decoupled from uiMode: which complexity panel (Easy/Advanced) to render,
    // shown even when the extension is off so config stays editable.
    configMode: UI_MODES.EASY,
    uiMode: UI_MODES.EASY,
    // Start of chat history: the host clamps the depth at its maximum
    // injection depth, so the slot lands after every preset block and before
    // the oldest chat text, which keeps the image wire order chronological.
    // The slider max must stay at the host maximum; a deeper default would sit
    // past the host's injection loop and never ship.
    customMemoryPosition: MEMORY_POSITIONS.IN_CHAT,
    customMemoryRole: MEMORY_ROLES.SYSTEM,
    customMemoryDepth: SLIDER_LIMITS.customMemoryDepth.MAX,
    minSummaryTurns: 3,
    maxSummaryTurns: 8,
    layer0SummaryTokenTarget: 280,
    maxL0SourceTokens: 24000,
    advancedModelContext: 48000,
    minSummaryBudget: 16000,
    verbatimTokenBudget: 22000,
    queuedTokenBudget: 6000,
    // Stamped from the memory-mode preset on mode transitions/reset.
    atomicPartitions: false,
    // Microfiche render knobs; they tune the image render only, never retention.
    microficheKeepRaw: 0,
    microficheImageCap: 8,
    // Old chat photos stay off until the user opts in on the mode picker.
    microficheFrozenRawImages: false,
    microficheFont: '8x13',
    microficheCellWidth: 11,
    microficheCellHeight: 16,
    microficheVariant: 'bw',
    microficheStopwordDim: false,
    microficheColumns: 1,
    microficheLineRepeat: 1,
    microficheFrameSize: 1568,
    microficheModelName: '',
    microficheGeometry: 'anthropic',
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
    auditorSystemPrompt: DEFAULT_AUDITOR_SYSTEM_PROMPT,
    auditorUserPrompt: DEFAULT_AUDITOR_USER_PROMPT,
    layer0RecallBody: LAYER0_RECALL_BODY,
    promotionRecallBody: PROMOTION_RECALL_BODY,

    summarizerSystemPromptPreset: 'narrative', // 'narrative' | 'custom'
    promptPreset: 'narrative', // 'narrative' | 'custom'
    summarizerRepairPromptPreset: 'narrative', // 'narrative' | 'custom'
    layer0RecallPreset: 'narrative', // 'narrative' | 'custom'
    promotionSystemPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionRepairPromptPreset: 'narrative', // 'narrative' | 'custom'
    promotionRecallPreset: 'narrative', // 'narrative' | 'custom'
    auditorSystemPromptPreset: 'continuity', // 'continuity' | 'custom'
    auditorPromptPreset: 'continuity', // 'continuity' | 'custom'
    applyRegexScripts: true, // true = apply ST's regex scripts to passage text before summarizing
    // true = also hide text-less messages (images, tool calls) inside the summarized
    // range. They carry no text to summarize, so without this they stay visible to the
    // model and leave gaps in the hidden range that still cost context.
    hideNonTextMessages: true,
    stripChineseIdeographs: true, // true = strip Han ideographs from summarizer responses
    guardMask: false, // true = replace spaces with $$ in outgoing main story chat text
    guardMaskMemory: false, // true = also mask stored memory in that request; needs guardMask
    // Trailing Preset CoT exemption: off masks the whole prompt, auto keeps a
    // fixed two-message window, on keeps guardMaskCotCount trailing messages.
    guardMaskCotMode: GUARD_MASK_COT_MODES.AUTO,
    guardMaskCotCount: GUARD_MASK_COT_AUTO_COUNT,
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
    continuityStateLogMode: false,
    continuityStateLogFullMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default', // 'default' | 'profile'
    summarizerResponseLength: 0, // 0 = provider/profile default
    connectionProfileId: '',
    requestTimeoutSeconds: 120, // Layer 0 / regenerate route

    // Optional Layer 1+ promotion merge connection. 'inherit' uses the Layer 0 connection above.
    mergeConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile'
    mergeSummarizerResponseLength: 0,
    mergeConnectionProfileId: '',
    mergeRequestTimeoutSeconds: 90, // Layer 1+ promotion route

    // Optional fallback connection used after the primary route exhausts retryable failures.
    fallbackConnectionSource: 'disabled', // 'disabled' | 'default' | 'profile'
    fallbackSummarizerResponseLength: 0,
    fallbackConnectionProfileId: '',
    fallbackRequestTimeoutSeconds: 120,

    // Dedicated Continuity Auditor connection, separate from the Narrative Chain (ADR-0009).
    auditorConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile'
    auditorSummarizerResponseLength: 0,
    auditorConnectionProfileId: '',
    auditorRequestTimeoutSeconds: 120, // auditor primary route
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

export const LAYER0_RECALL_PRESETS = {
    narrative: defaultSettings.layer0RecallBody,
    custom: null, // Uses whatever is in the textarea
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

export const PROMOTION_RECALL_PRESETS = {
    narrative: defaultSettings.promotionRecallBody,
    custom: null, // Uses whatever is in the textarea
};

export const AUDITOR_PROMPT_PRESETS = {
    continuity: defaultSettings.auditorUserPrompt,
    custom: null, // Uses whatever is in the textarea
};

export const AUDITOR_SYSTEM_PROMPT_PRESETS = {
    continuity: defaultSettings.auditorSystemPrompt,
    custom: null,
};

export const DEFAULT_PROMPT_PRESET = 'narrative';
export const DEFAULT_PROMOTION_PROMPT_PRESET = 'narrative';

/**
 * The ten (presetKey, settingKey) prompt pairs shared by persistence
 * normalization and the prompt UI bindings. Order defines UI field order, so
 * a family's recall pair sits after its payload pair.
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
    Object.freeze({ presetKey: 'layer0RecallPreset', settingKey: 'layer0RecallBody' }),
    Object.freeze({
        presetKey: 'promotionSystemPromptPreset',
        settingKey: 'promotionSystemPrompt',
    }),
    Object.freeze({ presetKey: 'promotionPromptPreset', settingKey: 'promotionUserPrompt' }),
    Object.freeze({
        presetKey: 'promotionRepairPromptPreset',
        settingKey: 'promotionRepairPrompt',
    }),
    Object.freeze({ presetKey: 'promotionRecallPreset', settingKey: 'promotionRecallBody' }),
    Object.freeze({
        presetKey: 'auditorSystemPromptPreset',
        settingKey: 'auditorSystemPrompt',
    }),
    Object.freeze({ presetKey: 'auditorPromptPreset', settingKey: 'auditorUserPrompt' }),
]);

// ─── Retry Configuration ─────────────────────────────────────────────

export const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};

// Consecutive failed primary+fallback route cycles before one request gives up
// with a failed Run Outcome instead of retrying forever (mirrors the Promotion
// Drain failure budget).
export const ROUTE_CYCLE_FAILURE_BUDGET = 1;
