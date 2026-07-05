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
    minSummaryBudget: 8000,
    verbatimTokenBudget: 16000,
    memoryTokenBudget: 10000,
    snippetsPerLayer: 30,
    snippetsPerPromotion: 3,
    injectionTemplate:
        '<summaryception_memory>\n' +
        'This is condensed continuity memory from older chat turns that may be hidden from the live prompt. Use it as factual background for prior events, relationships, locations, goals, unresolved threads, and character state. Recent verbatim chat takes priority for immediate wording, tone, and next action.\n\n' +
        '{{summary}}\n' +
        '</summaryception_memory>',

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the essential narrative progression and state changes from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.

### TRACKING PRIORITIES:
1. **Chronological Events & Actions:** What happened, who initiated it, and the immediate outcome.
2. **Relationship & Power Dynamics:** Shifts in intimacy, dominant/submissive rules established, emotional vulnerability, or verbal agreements/promises.
3. **Physical & Inventory State:** Specific clothing worn/removed, items bought/used (e.g., lube, collar, wine), specific locations, and current time of day.
4. **Unresolved Tensions:** Pending actions, anticipation, or immediate next steps (e.g., "waiting for alarm", "package arriving Wednesday").

### EXCLUSIONS:
- Exclude internal monologue that doesn't lead to action.
- Exclude repetitive environmental descriptions, conversational filler, and events already established in <prior_context>.

### FORMATTING:
Output a single, highly dense chronological paragraph separated by semicolons. Use clear, active phrasing. Do not include introductory preamble, markdown code blocks, or meta-commentary.`,

    promotionSystemPrompt:
        'Role: layered memory synthesizer. Merge lower-layer memories into a smaller, durable continuity summary. Preserve lasting facts, current state, unresolved hooks, and cause/effect; deduplicate repeated beats and generalize moment-to-moment detail. Output only the summary text - no preamble, no commentary, no markdown.',

    promotionUserPrompt: `<prior_context>
{{context_str}}
</prior_context>

<memories_to_consolidate>
{{story_txt}}
</memories_to_consolidate>

Consolidate <memories_to_consolidate> into a smaller Layer 1+ memory that coherently follows <prior_context>.

### SYNTHESIS PRIORITIES:
1. Durable narrative/game state: relationships, agreements, goals, quests, locations, inventory, resources, injuries, rules, world facts, and permanent character changes.
2. Current state and unresolved hooks: where people are, what they intend next, pending deadlines, promises, threats, mysteries, tasks, or hazards.
3. Cause and effect: preserve why important state changed, but collapse repeated actions into their stable outcome.

### COMPRESSION RULES:
- Deduplicate anything already fully captured in <prior_context>.
- Replace repeated micro-actions, dialogue loops, and transitional beats with one concise outcome.
- Drop flavor, filler, and low-impact moment-to-moment detail unless it changes durable state.
- Keep specific names, places, items, numbers, and constraints when they matter later.
- If the memories conflict, keep the newest concrete state and omit obsolete wording.

### FORMAT:
Write one dense third-person paragraph. Never use second-person. Do not include headings, bullets, markdown, code blocks, or meta-commentary.`,

    promptPreset: 'narrative', // 'narrative' | 'gamestate' | 'custom'
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
    promptLogMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default', // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0, // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '', // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [], // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0, // 0 = no limit (provider default)

    // Optional Layer 1+ promotion merge connection. 'inherit' uses the Layer 0 connection above.
    mergeConnectionSource: 'inherit', // 'inherit' | 'default' | 'profile' | 'ollama' | 'openai'
    mergeSummarizerResponseLength: 0,
    mergeConnectionProfileId: '',
    mergeOllamaModel: '',
    mergeOpenaiModel: '',
    mergeOpenaiMaxTokens: 0,
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

Summarize only the essential narrative progression and state changes from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.

### TRACKING PRIORITIES:
1. **Chronological Events & Actions:** What happened, who initiated it, and the immediate outcome.
2. **Relationship & Power Dynamics:** Shifts in intimacy, dominant/submissive rules established, emotional vulnerability, or verbal agreements/promises.
3. **Physical & Inventory State:** Specific clothing worn/removed, items bought/used (e.g., lube, collar, wine), specific locations, and current time of day.
4. **Unresolved Tensions:** Pending actions, anticipation, or immediate next steps (e.g., "waiting for alarm", "package arriving Wednesday").

### EXCLUSIONS:
- Exclude internal monologue that doesn't lead to action.
- Exclude repetitive environmental descriptions, conversational filler, and events already established in <prior_context>.

### FORMATTING:
Output a single, highly dense chronological paragraph separated by semicolons. Use clear, active phrasing. Do not include introductory preamble, markdown code blocks, or meta-commentary.`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

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
