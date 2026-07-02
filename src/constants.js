export const MODULE_NAME = 'summaryception';
export const LOG_PREFIX = '[Summaryception]';

// ─── Default Settings ────────────────────────────────────────────────

export const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 10,
    turnsPerSummary: 3,
    snippetsPerLayer: 30,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    injectionTemplate: '\n\n<summary>\n{{summary}}\n</summary>\n\n',

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt:
        `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,  // true = mark as summarized but don't hide messages

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

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
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

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

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
