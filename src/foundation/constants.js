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
        'This is condensed continuity memory from older chat turns that may be hidden from the live prompt. Use it as factual background for prior events, relationships, locations, goals, unresolved threads, and character state. Memory is grouped by layer: higher-numbered <Lx> layers are older and more compressed, while lower-numbered layers are newer, with <L0> closest to the recent verbatim chat. Recent verbatim chat takes priority for immediate wording, tone, and next action.\n\n' +
        '{{summary}}\n' +
        '</summaryception_memory>',

    summarizerSystemPrompt:
        'Role: aggressive narrative-state compressor. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Compress only the essential narrative progression and state changes from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.

### TARGET:
Follow the runtime Layer 0 target length. If the passage is event-heavy, prefer durable state over moment-by-moment replay.

### KEEP:
1. **Durable chronology:** Major actions, time jumps, location changes, decisions, commitments, and current position.
2. **State changes:** Relationship status, boundaries, agreements, physical/emotional condition, revealed secrets, constraints, resources, and plans.
3. **Unresolved hooks:** Pending actions, next intended step, promises, deadlines, risks, or anything the next reply must remember.

### EXCLUSIONS:
- Exclude internal monologue unless it creates lasting intent or concealment.
- Exclude repeated micro-actions, sensory detail, banter, flavor dialogue, and atmosphere unless they change durable state.
- Collapse repeated intimate/action beats into outcomes, boundaries, tally/state changes, and immediate consequences.

### FORMATTING:
Output one highly compressed chronological paragraph. Use semicolons only where useful. Do not include introductory preamble, markdown code blocks, or meta-commentary.`,

    promotionSystemPrompt:
        'Role: layered memory synthesizer. Merge lower-layer memories into a smaller, durable continuity summary. Preserve lasting facts, current state, unresolved hooks, and cause/effect; deduplicate repeated beats and generalize moment-to-moment detail. Output only the summary text - no preamble, no commentary, no markdown.',

    promotionUserPrompt: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<memories_to_consolidate>
{{story_txt}}
</memories_to_consolidate>

Consolidate only the new information from <memories_to_consolidate> into a highly compressed continuation block.

### CRITICAL TEMPORAL RULES:
1. **No Historical Rewriting:** <prior_context> is your established, immutable baseline history. Do NOT re-summarize, duplicate, or re-write any events, dates, or details already recorded in <prior_context>.
2. **Strict Delta Scoping:** Your output must ONLY summarize the new events occurring within <memories_to_consolidate>.
3. **Appended Continuity:** Structure the output so that it chronologically and seamlessly appends directly to the end of <prior_context> without looking back or repeating past timelines.
4. **Temporal Anchors:** Preserve useful full date/time anchors already present in lower-layer memory (for example, Saturday Oct 19, 7PM). Do not reduce inferable absolute timing to vague relative timing; for future goals/plans, prefer full dates over bare weekdays when available.

### SYNTHESIS PRIORITIES:
1. **Durable Narrative State:** Permanent changes to relationships, agreements, rules, and core character development.
2. **Unresolved Hooks:** Where the characters are currently positioned, what they intend to do next, or pending immediate agreements.
3. **Deduplication:** Omit transitional actions, low-impact micro-movements, and momentary dialogue loops.

### FORMAT:
Write one dense third-person paragraph. Never use second-person. Do not include headings, bullets, markdown, code blocks, or meta-commentary.`,

    promptPreset: 'narrative', // 'narrative' | 'custom'
    savedCustomPrompts: {}, // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '', // Auto-saved when switching away from custom
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
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Compress only the essential narrative progression and state changes from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.

### TARGET:
Follow the runtime Layer 0 target length. If the passage is event-heavy, prefer durable state over moment-by-moment replay.

### KEEP:
1. **Durable chronology:** Major actions, time jumps, location changes, decisions, commitments, and current position.
2. **State changes:** Relationship status, boundaries, agreements, physical/emotional condition, revealed secrets, constraints, resources, and plans.
3. **Unresolved hooks:** Pending actions, next intended step, promises, deadlines, risks, or anything the next reply must remember.

### EXCLUSIONS:
- Exclude internal monologue unless it creates lasting intent or concealment.
- Exclude repeated micro-actions, sensory detail, banter, flavor dialogue, and atmosphere unless they change durable state.
- Collapse repeated intimate/action beats into outcomes, boundaries, tally/state changes, and immediate consequences.

### FORMATTING:
Output one highly compressed chronological paragraph. Use semicolons only where useful. Do not include introductory preamble, markdown code blocks, or meta-commentary.`,

    custom: null, // Uses whatever is in the textarea
};

export const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Retry Configuration ─────────────────────────────────────────────

export const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};
