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
    layer0SummaryTokenTarget: 150,
    minSummaryBudget: 8000,
    verbatimTokenBudget: 16000,
    memoryTokenBudget: 10000,
    snippetsPerLayer: 30,
    snippetsPerPromotion: 4,
    injectionTemplate:
        '<summaryception_memory>\n' +
        'This is condensed continuity memory from older chat turns. The [CURRENT STATE] block contains active durable facts. The [CHRONOLOGY] section contains older narrative. Use both as factual background; recent verbatim chat takes priority for immediate wording, tone, and next action.\n\n' +
        '{{summary}}\n' +
        '</summaryception_memory>',

    summarizerSystemPrompt:
        'Role: narrative-state dual compressor. Output a [NARRATIVE] paragraph and a [STATE] key-value block. No preamble, no commentary.',

    summarizerUserPrompt: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Compress only the essential narrative progression and changed durable state from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.

Output exactly two sections:

[NARRATIVE]
<one dense chronological prose paragraph covering events, actions, and outcomes>

[STATE]
Extract only durable state variables that CHANGED or became newly relevant in this passage. Format as key: value, one per line.
Omit unchanged state. Omission means the previous value is preserved.
To delete a resolved or emptied variable, write: key: none

Common keys (use what is relevant, invent new ones if needed):
- location: <current place>
- characters: <name: brief status, ...>
- inventory: <active items/equipment>
- dynamics: <relationship/power state>
- hooks: <unresolved plans/threats>
- counters: <name: value, ...>

Do not narrate events inside [STATE]. Only current facts. If nothing changed, output [STATE] with no keys below it.`,

    promotionSystemPrompt:
        'Role: dual-track memory synthesizer. Summarize narrative prose only. State blocks are merged separately in code. Output only the narrative paragraph - no preamble, no commentary, no markdown.',

    promotionUserPrompt: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<narratives_to_consolidate>
{{story_txt}}
</narratives_to_consolidate>

Consolidate only the NEW events from <narratives_to_consolidate> into a highly compressed continuation that follows the runtime Layer 1+ target length.

### CRITICAL TEMPORAL RULES:
1. **No Historical Rewriting:** <prior_context> is your established, immutable baseline history. Do NOT re-summarize, duplicate, or re-write any events, dates, or details already recorded in <prior_context>.
2. **Strict Delta Scoping:** Your output must ONLY summarize the new events occurring within <narratives_to_consolidate>.
3. **Appended Continuity:** Structure the output so that it chronologically and seamlessly appends directly to the end of <prior_context> without looking back or repeating past timelines.
4. **Temporal Anchors:** Preserve useful full date/time anchors already present in lower-layer memory (for example, Saturday Oct 19, 7PM). Do not reduce inferable absolute timing to vague relative timing; for future goals/plans, prefer full dates over bare weekdays when available.

### SYNTHESIS PRIORITIES:
1. **Durable Narrative State:** Permanent changes to relationships, agreements, rules, and core character development.
2. **Unresolved Hooks:** Where the characters are currently positioned, what they intend to do next, or pending immediate agreements.
3. **Deduplication:** Omit transitional actions, low-impact micro-movements, scene replay, and momentary dialogue loops.
4. **Abstraction:** Merge repeated related beats into one cumulative state change, boundary, rule, or outcome.

### FORMAT:
Write one dense third-person narrative paragraph. Never use second-person. Do not include headings, bullets, markdown, code blocks, [NARRATIVE], [STATE], or meta-commentary.`,

    promptPreset: 'narrative', // 'narrative' | 'custom'
    savedCustomPrompts: {}, // { name: promptText } — named custom prompt slots
    promotionPromptPreset: 'narrative', // 'narrative' | 'custom'
    savedCustomPromotionPrompts: {}, // { name: promptText } — named custom promotion prompt slots
    applyRegexScripts: true, // true = apply ST's regex scripts to passage text before summarizing

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
    promptLogMode: false,

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

export const PROMOTION_PROMPT_PRESETS = {
    narrative: defaultSettings.promotionUserPrompt,
    custom: null, // Uses whatever is in the textarea
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
