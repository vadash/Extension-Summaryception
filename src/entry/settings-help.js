const HELP_EVENT_NS = '.summaryceptionSettingsHelp';
const HELP_TOOLTIP_ID = 'sc_help_tooltip';
const HELP_TARGET_SELECTOR = '.sc-help-target';
const HELP_FOCUS_SELECTOR = [
    '.sc-help-target',
    '.sc-help-target input',
    '.sc-help-target select',
    '.sc-help-target textarea',
    '[data-sc-help-control]',
].join(', ');

const selectorFor = (id) => `label[for="${id}"]`;
const controlFor = (id) => `#${id}`;

const sliderHelp = ({ selector, title, short, meaning, higher, lower, defaultText, controls }) => ({
    selector,
    title,
    short,
    detail: `${meaning} Higher ${higher} Lower ${lower} Default ${defaultText}`,
    controls,
});

const basicHelp = ({ selector, title, short, controls, controlsText, when, risk }) => ({
    selector,
    title,
    short,
    detail: `${controlsText} Change it ${when} Main risk: ${risk}`,
    controls,
});

const CONNECTION_GROUPS = [
    {
        key: 'layer0',
        label: 'Layer 0',
        route: 'main raw-chat summarizer route used for new Layer 0 memories and Layer 0 regeneration.',
        sourceId: 'summaryception_connection_source',
        responseLengthId: 'sc_summarizer_response_length',
        profileId: 'summaryception_connection_profile',
        ollamaUrlId: 'summaryception_ollama_url',
        ollamaModelId: 'summaryception_ollama_model',
        openaiUrlId: 'summaryception_openai_url',
        openaiKeyId: 'summaryception_openai_key',
        openaiModelId: 'summaryception_openai_model',
        openaiMaxTokensId: 'summaryception_openai_max_tokens',
        sourceRisk: 'a weak or misconfigured route makes every new summary worse.',
        responseDefault: '0 uses the Layer 0 target plus a safety buffer.',
        openaiDefault: '0 uses the Layer 0 target plus a safety buffer.',
    },
    {
        key: 'merge',
        label: 'Merge',
        route: 'optional Layer 1+ promotion route used when lower memories are merged into deeper memory.',
        sourceId: 'summaryception_merge_connection_source',
        responseLengthId: 'sc_merge_summarizer_response_length',
        profileId: 'summaryception_merge_connection_profile',
        ollamaUrlId: 'summaryception_merge_ollama_url',
        ollamaModelId: 'summaryception_merge_ollama_model',
        openaiUrlId: 'summaryception_merge_openai_url',
        openaiKeyId: 'summaryception_merge_openai_key',
        openaiModelId: 'summaryception_merge_openai_model',
        openaiMaxTokensId: 'summaryception_merge_openai_max_tokens',
        sourceRisk: 'a mismatched merge route can rewrite stable memory in a different style.',
        responseDefault: '0 uses the selected provider default.',
        openaiDefault: '0 leaves the provider default.',
    },
    {
        key: 'fallback',
        label: 'Fallback',
        route: 'backup summarizer route used only after retryable primary failures.',
        sourceId: 'summaryception_fallback_connection_source',
        responseLengthId: 'sc_fallback_summarizer_response_length',
        profileId: 'summaryception_fallback_connection_profile',
        ollamaUrlId: 'summaryception_fallback_ollama_url',
        ollamaModelId: 'summaryception_fallback_ollama_model',
        openaiUrlId: 'summaryception_fallback_openai_url',
        openaiKeyId: 'summaryception_fallback_openai_key',
        openaiModelId: 'summaryception_fallback_openai_model',
        openaiMaxTokensId: 'summaryception_fallback_openai_max_tokens',
        sourceRisk: 'it is ignored if it matches the primary route.',
        responseDefault: '0 uses the selected provider default.',
        openaiDefault: '0 leaves the provider default.',
    },
];

const CONNECTION_ENTRY_BUILDERS = [
    connectionSourceHelp,
    responseLengthHelp,
    profileHelp,
    ollamaUrlHelp,
    ollamaModelHelp,
    openaiUrlHelp,
    openaiKeyHelp,
    openaiModelHelp,
    openaiMaxTokensHelp,
];

const CONNECTION_HELP_ENTRIES = CONNECTION_GROUPS.flatMap((group) =>
    CONNECTION_ENTRY_BUILDERS.map((build) => build(group)).filter(Boolean),
);

const HELP_ENTRIES = [
    [
        'enabled',
        basicHelp({
            selector: selectorFor('sc_enabled'),
            title: 'Enable Summaryception',
            short: 'Turn memory injection and automatic summarizing on.',
            controls: [controlFor('sc_enabled')],
            controlsText:
                'Controls whether committed Summaryception memory is injected and background summarizing can run.',
            when: 'when you want this chat to use layered memory.',
            risk: 'turning it off stops new memory injection until it is enabled again.',
        }),
    ],
    [
        'apply_regex_scripts',
        basicHelp({
            selector: selectorFor('sc_apply_regex_scripts'),
            title: 'Apply Regex Scripts',
            short: 'Let summaries see text after your ST regex cleanup.',
            controls: [controlFor('sc_apply_regex_scripts')],
            controlsText:
                'Controls whether SillyTavern regex scripts are applied before text is sent to the summarizer.',
            when: 'if your main model also sees regex-cleaned text.',
            risk: 'turning it off can make summaries remember text the RP model never saw.',
        }),
    ],
    [
        'strip_chinese_ideographs',
        basicHelp({
            selector: selectorFor('sc_strip_chinese_ideographs'),
            title: 'Strip CN',
            short: 'Remove Han ideographs from summarizer replies.',
            controls: [controlFor('sc_strip_chinese_ideographs')],
            controlsText:
                'Controls whether generated summaries strip Han ideographs and reject heavily contaminated replies.',
            when: 'if your summarizer sometimes leaks Chinese text into memory.',
            risk: 'legitimate Chinese names or text will be removed from committed memory.',
        }),
    ],
    [
        'verbatim_token_budget',
        sliderHelp({
            selector: selectorFor('sc_verbatim_token_budget'),
            title: 'Verbatim Token Budget',
            short: 'Recent chat kept word-for-word before summaries start.',
            controls: [
                controlFor('sc_verbatim_token_budget'),
                controlFor('sc_verbatim_token_budget_val'),
            ],
            meaning: 'Recent chat kept word-for-word before older turns become Layer 0 summaries.',
            higher: 'keeps more exact recent chat but uses more context.',
            lower: 'summarizes sooner and leaves more room for memory.',
            defaultText: '16k; Cache Friendly switches this to 32k.',
        }),
    ],
    [
        'memory_token_budget',
        sliderHelp({
            selector: selectorFor('sc_memory_token_budget'),
            title: 'Injected Memory Budget',
            short: 'Maximum memory block size sent to the model.',
            controls: [
                controlFor('sc_memory_token_budget'),
                controlFor('sc_memory_token_budget_val'),
            ],
            meaning:
                'Maximum ceiling for committed Summaryception memory injected into the prompt; actual use may sit below it after compression and promotion cycles.',
            higher: 'keeps more detailed memory before promotion pressure rises.',
            lower: 'promotes and compresses memory sooner; 4k is the hard ceiling where consolidation becomes aggressive.',
            defaultText: '10k.',
        }),
    ],
    [
        'layer0_summary_token_target',
        sliderHelp({
            selector: selectorFor('sc_layer0_summary_token_target'),
            title: 'Layer 0 Target Tokens',
            short: 'Target size for each raw-chat summary.',
            controls: [
                controlFor('sc_layer0_summary_token_target'),
                controlFor('sc_layer0_summary_token_target_val'),
            ],
            meaning: 'Target size for one Layer 0 summary before it is injected as memory.',
            higher: 'keeps more detail in each Layer 0 snippet.',
            lower: 'compresses each snippet harder and leaves more memory budget.',
            defaultText: '200.',
        }),
    ],
    [
        'min_summary_budget',
        sliderHelp({
            selector: selectorFor('sc_min_summary_budget'),
            title: 'Minimum Summary Budget',
            short: 'How much overflow text to collect before short batches run.',
            controls: [
                controlFor('sc_min_summary_budget'),
                controlFor('sc_min_summary_budget_val'),
            ],
            meaning:
                'Minimum overflow passage size before a normal Layer 0 batch is worth summarizing.',
            higher: 'waits for bigger chunks and makes fewer summarizer calls.',
            lower: 'summarizes smaller chunks sooner.',
            defaultText: '8k.',
        }),
    ],
    [
        'min_summary_turns',
        sliderHelp({
            selector: selectorFor('sc_min_summary_turns'),
            title: 'Minimum Summary Turns',
            short: 'Fewest assistant turns needed before a batch can run.',
            controls: [controlFor('sc_min_summary_turns'), controlFor('sc_min_summary_turns_val')],
            meaning: 'Minimum assistant-turn count before a budget-ready Layer 0 batch can run.',
            higher: 'waits for more conversation before summarizing.',
            lower: 'allows shorter batches to be summarized.',
            defaultText: '3.',
        }),
    ],
    [
        'max_summary_turns',
        sliderHelp({
            selector: selectorFor('sc_max_summary_turns'),
            title: 'Maximum Summary Turns',
            short: 'Most assistant turns placed in one Layer 0 batch.',
            controls: [controlFor('sc_max_summary_turns'), controlFor('sc_max_summary_turns_val')],
            meaning: 'Maximum assistant-turn count in one Layer 0 summary request.',
            higher: 'packs more chat into each summary call.',
            lower: 'keeps each summary request smaller and easier.',
            defaultText: '8.',
        }),
    ],
    [
        'snippets_per_layer',
        sliderHelp({
            selector: selectorFor('sc_snippets_per_layer'),
            title: 'Max Memories per Layer',
            short: 'Count limit before a layer is pushed deeper.',
            controls: [
                controlFor('sc_snippets_per_layer'),
                controlFor('sc_snippets_per_layer_val'),
            ],
            meaning:
                'Maximum memory snippets a layer should hold before promotion pressure applies.',
            higher: 'keeps more separate memories in each layer.',
            lower: 'merges memories into deeper layers sooner.',
            defaultText: '24.',
        }),
    ],
    [
        'snippets_per_promotion',
        sliderHelp({
            selector: selectorFor('sc_snippets_per_promotion'),
            title: 'Snippets per Promotion',
            short: 'How many old memories are merged at once.',
            controls: [
                controlFor('sc_snippets_per_promotion'),
                controlFor('sc_snippets_per_promotion_val'),
            ],
            meaning: 'Number of oldest snippets bundled when a layer promotes memory deeper.',
            higher: 'makes fewer, larger promotion merges and is useful for 2000+ message chats.',
            lower: 'makes smaller promotion merges more often and is better for shorter chats.',
            defaultText: '3.',
        }),
    ],
    [
        'memory_mode_standard',
        basicHelp({
            selector: selectorFor('sc_memory_mode_standard'),
            title: 'Standard',
            short: 'Normal rolling summaries with the regular live window.',
            controls: [controlFor('sc_memory_mode_standard')],
            controlsText:
                'Controls whether Summaryception uses the regular rolling verbatim window and continuous summaries.',
            when: 'for most chats and providers.',
            risk: 'provider prompt caching may be less stable than Cache Friendly mode.',
        }),
    ],
    [
        'memory_mode_cache',
        basicHelp({
            selector: selectorFor('sc_memory_mode_cache'),
            title: 'Cache Friendly',
            short: 'Freeze memory shape and keep a larger live chat window.',
            controls: [controlFor('sc_memory_mode_cache')],
            controlsText:
                'Controls whether the prompt keeps a stable memory prefix and lets live chat grow to a larger cache window.',
            when: 'if your provider rewards stable prompt prefixes.',
            risk: 'manual summarization or cache flushes can reset some cache savings.',
        }),
    ],
    [
        'memory_mode_custom',
        basicHelp({
            selector: selectorFor('sc_memory_mode_custom'),
            title: 'Custom',
            short: 'Choose where and how the memory block is injected.',
            controls: [controlFor('sc_memory_mode_custom')],
            controlsText:
                'Controls whether you can override the memory position, role, and chat depth.',
            when: 'if a preset or model needs memory placed differently.',
            risk: 'a poor placement can make the model ignore or over-weight memory.',
        }),
    ],
    [
        'custom_memory_position',
        basicHelp({
            selector: selectorFor('sc_custom_memory_position'),
            title: 'Memory Position',
            short: 'Where custom memory is placed in the ST prompt.',
            controls: [controlFor('sc_custom_memory_position')],
            controlsText: 'Controls where the combined memory block is inserted.',
            when: 'only in Custom mode when your prompt layout needs a specific location.',
            risk: 'placing memory too late or too early can change how strongly the model follows it.',
        }),
    ],
    [
        'custom_memory_role',
        basicHelp({
            selector: selectorFor('sc_custom_memory_role'),
            title: 'Memory Role',
            short: 'Message role used when memory is injected as chat.',
            controls: [controlFor('sc_custom_memory_role')],
            controlsText:
                'Controls the role assigned to custom memory when it is sent as a chat message.',
            when: 'if a provider treats system, user, and assistant messages differently.',
            risk: 'the wrong role can make memory sound like instructions or like dialogue.',
        }),
    ],
    [
        'custom_memory_depth',
        basicHelp({
            selector: selectorFor('sc_custom_memory_depth'),
            title: 'Chat Depth',
            short: 'How far back memory is inserted when using In Chat.',
            controls: [controlFor('sc_custom_memory_depth')],
            controlsText: 'Controls the chat depth used for custom In Chat memory placement.',
            when: 'only when Memory Position is In Chat.',
            risk: 'a bad depth can put memory too near or too far from the latest turn.',
        }),
    ],
    ...CONNECTION_HELP_ENTRIES,
    [
        'layer0_system_prompt',
        basicHelp({
            selector: selectorFor('sc_summarizer_system_prompt'),
            title: 'Layer 0 System Prompt',
            short: 'Instruction style for raw-chat summaries.',
            controls: [controlFor('sc_summarizer_system_prompt')],
            controlsText:
                'Controls the system instruction sent with raw chat summarization requests.',
            when: 'if the summarizer needs a different role or stricter output style.',
            risk: 'too much instruction can make summaries verbose or inconsistent.',
        }),
    ],
    [
        'prompt_preset',
        basicHelp({
            selector: selectorFor('sc_prompt_preset'),
            title: 'Prompt Preset',
            short: 'Choose the Layer 0 user-prompt template.',
            controls: [controlFor('sc_prompt_preset')],
            controlsText: 'Controls which Layer 0 user prompt template is active.',
            when: 'when switching between narrative memory and your own custom prompt.',
            risk: 'changing presets can change what future summaries preserve.',
        }),
    ],
    [
        'saved_custom_prompts',
        basicHelp({
            selector: selectorFor('sc_custom_prompt_slot'),
            title: 'Saved Custom Prompts',
            short: 'Load one of your saved Layer 0 custom prompts.',
            controls: [controlFor('sc_custom_prompt_slot')],
            controlsText:
                'Controls which saved custom prompt slot is selected for loading or deleting.',
            when: 'when reusing a prompt you previously saved.',
            risk: 'loading the wrong slot replaces the current Layer 0 user prompt text.',
        }),
    ],
    [
        'custom_prompt_name',
        basicHelp({
            selector: controlFor('sc_custom_prompt_name'),
            title: 'Prompt Name',
            short: 'Name used when saving the current custom prompt.',
            controls: [controlFor('sc_custom_prompt_name')],
            controlsText: 'Controls the saved slot name for the current custom prompt.',
            when: 'before saving a reusable prompt.',
            risk: 'using an existing name overwrites that saved prompt.',
        }),
    ],
    [
        'layer0_user_prompt',
        basicHelp({
            selector: selectorFor('sc_summarizer_user_prompt'),
            title: 'Layer 0 User Prompt',
            short: 'Template that turns raw chat into Layer 0 memory.',
            controls: [controlFor('sc_summarizer_user_prompt')],
            controlsText:
                'Controls the user prompt for raw-chat summaries and can use {{player_name}}, {{context_str}}, and {{story_txt}}.',
            when: 'if the current preset misses the facts you care about.',
            risk: 'missing variables or asking for long output can break compact memory.',
        }),
    ],
    [
        'injection_template',
        basicHelp({
            selector: selectorFor('sc_injection_template'),
            title: 'Injection Wrapper Template',
            short: 'Wrapper text around the combined memory block.',
            controls: [controlFor('sc_injection_template')],
            controlsText:
                'Controls the wrapper around injected memory and must include {{summary}}.',
            when: 'if your model follows a different memory tag or framing better.',
            risk: 'removing {{summary}} means no memory text is injected.',
        }),
    ],
    [
        'promotion_system_prompt',
        basicHelp({
            selector: selectorFor('sc_promotion_system_prompt'),
            title: 'Promotion System Prompt',
            short: 'Instruction style for deeper memory merges.',
            controls: [controlFor('sc_promotion_system_prompt')],
            controlsText: 'Controls the system instruction used when Layer 1+ memories are merged.',
            when: 'if promoted memories need a different compression style.',
            risk: 'bad merge instructions can erase durable facts.',
        }),
    ],
    [
        'promotion_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_promotion_prompt_preset'),
            title: 'Promotion Prompt Preset',
            short: 'Choose the Layer 1+ merge user-prompt template.',
            controls: [controlFor('sc_promotion_prompt_preset')],
            controlsText: 'Controls which Layer 1+ promotion user prompt template is active.',
            when: 'when switching between narrative promotion memory and your own custom prompt.',
            risk: 'changing presets can change how deeper summaries preserve durable facts.',
        }),
    ],
    [
        'saved_custom_promotion_prompts',
        basicHelp({
            selector: selectorFor('sc_promotion_custom_prompt_slot'),
            title: 'Saved Promotion Prompts',
            short: 'Load one of your saved Layer 1+ custom prompts.',
            controls: [controlFor('sc_promotion_custom_prompt_slot')],
            controlsText:
                'Controls which saved promotion prompt slot is selected for loading or deleting.',
            when: 'when reusing a promotion prompt you previously saved.',
            risk: 'loading the wrong slot replaces the current Layer 1+ user prompt text.',
        }),
    ],
    [
        'promotion_custom_prompt_name',
        basicHelp({
            selector: controlFor('sc_promotion_custom_prompt_name'),
            title: 'Promotion Prompt Name',
            short: 'Name used when saving the current promotion custom prompt.',
            controls: [controlFor('sc_promotion_custom_prompt_name')],
            controlsText: 'Controls the saved slot name for the current promotion custom prompt.',
            when: 'before saving a reusable promotion prompt.',
            risk: 'using an existing name overwrites that saved prompt.',
        }),
    ],
    [
        'promotion_user_prompt',
        basicHelp({
            selector: selectorFor('sc_promotion_user_prompt'),
            title: 'Promotion User Prompt',
            short: 'Template that merges lower memory into deeper memory.',
            controls: [controlFor('sc_promotion_user_prompt')],
            controlsText:
                'Controls the user prompt for Layer 1+ promotion and can use {{player_name}}, {{context_str}}, and {{story_txt}}.',
            when: 'if deeper memories keep too much detail or lose key state.',
            risk: 'weak instructions can create bloated or lossy meta-summaries.',
        }),
    ],
    [
        'strip_patterns',
        basicHelp({
            selector: selectorFor('sc_strip_patterns'),
            title: 'Strip Patterns',
            short: 'Text patterns removed from summarizer responses.',
            controls: [controlFor('sc_strip_patterns')],
            controlsText: 'Controls one-per-line patterns stripped from generated summary text.',
            when: 'if a summarizer keeps adding unwanted tags or thinking markers.',
            risk: 'overbroad patterns can remove useful memory text.',
        }),
    ],
    [
        'debug_mode',
        basicHelp({
            selector: selectorFor('sc_debug_mode'),
            title: 'Debug Mode',
            short: 'Show extra Summaryception console logs.',
            controls: [controlFor('sc_debug_mode')],
            controlsText: 'Controls verbose Summaryception diagnostic logging.',
            when: 'while troubleshooting behavior.',
            risk: 'logs can be noisy and may mention chat-derived state.',
        }),
    ],
    [
        'trace_mode',
        basicHelp({
            selector: selectorFor('sc_trace_mode'),
            title: 'Trace Mode',
            short: 'Show detailed flow logs when Debug Mode is on.',
            controls: [controlFor('sc_trace_mode')],
            controlsText: 'Controls the most detailed Summaryception flow logging.',
            when: 'only when Debug Mode is on and you need step-by-step behavior.',
            risk: 'trace logs are very noisy.',
        }),
    ],
    [
        'prompt_input_log_mode',
        basicHelp({
            selector: selectorFor('sc_prompt_input_log_mode'),
            title: 'Log LLM Inputs',
            short: 'Print full final summarizer inputs to the console.',
            controls: [controlFor('sc_prompt_input_log_mode')],
            controlsText:
                'Controls whether full final system and user prompt content sent to the summarizer is logged.',
            when: 'only when diagnosing prompt quality.',
            risk: 'the browser console may contain private chat text.',
        }),
    ],
    [
        'prompt_output_log_mode',
        basicHelp({
            selector: selectorFor('sc_prompt_output_log_mode'),
            title: 'Log LLM Outputs',
            short: 'Print cleaned summarizer replies to the console.',
            controls: [controlFor('sc_prompt_output_log_mode')],
            controlsText: 'Controls whether cleaned summarizer replies and errors are logged.',
            when: 'only when diagnosing provider output or cleanup behavior.',
            risk: 'the browser console may contain private chat text.',
        }),
    ],
];

/**
 * Metadata for settings help annotations and tooltips.
 * @type {Record<string, {selector: string, title: string, short: string, detail: string, controls?: string[]}>}
 */
export const SETTINGS_HELP = defineHelpMap(HELP_ENTRIES);

/**
 * Annotate the rendered settings DOM and bind the shared help tooltip.
 * @returns {void}
 */
export function initSettingsHelp() {
    const $settings = $('.sc-settings').last();
    if (!$settings.length) {
        return;
    }

    for (const [key, entry] of Object.entries(SETTINGS_HELP)) {
        annotateHelpEntry($settings, key, entry);
    }

    const $tooltip = getHelpTooltip($settings);
    bindHelpTooltip($settings, $tooltip);
}

/**
 * Calculate viewport coordinates for the shared settings help tooltip.
 * @param {object} p
 * @param {{left: number, right: number, top: number, bottom: number}} p.anchorRect
 * @param {{left: number, right: number}} p.settingsRect
 * @param {number} p.tooltipWidth
 * @param {number} p.tooltipHeight
 * @param {number} p.viewportWidth
 * @param {number} p.viewportHeight
 * @returns {{left: number, top: number}}
 */
export function calculateHelpTooltipPosition({
    anchorRect,
    settingsRect,
    tooltipWidth,
    tooltipHeight,
    viewportWidth,
    viewportHeight,
}) {
    const minLeft = Math.max(8, settingsRect.left + 6);
    const maxLeft = Math.max(
        minLeft,
        Math.min(viewportWidth - tooltipWidth - 8, settingsRect.right - tooltipWidth - 6),
    );
    let top = anchorRect.bottom + 6;

    if (top + tooltipHeight > viewportHeight - 8) {
        top = anchorRect.top - tooltipHeight - 6;
    }

    return {
        left: clamp(anchorRect.left, minLeft, maxLeft),
        top: clamp(top, 8, Math.max(8, viewportHeight - tooltipHeight - 8)),
    };
}

function defineHelpMap(entries) {
    const result = {};
    const seen = new Set();
    for (const [key, entry] of entries) {
        if (seen.has(key)) {
            throw new Error(`Duplicate Summaryception settings help key: ${key}`);
        }
        seen.add(key);
        result[key] = entry;
    }
    return Object.freeze(result);
}

function connectionSourceHelp(group) {
    return [
        `${group.key}_source`,
        basicHelp({
            selector: selectorFor(group.sourceId),
            title: `${group.label} Source`,
            short: getConnectionSourceShort(group),
            controls: [controlFor(group.sourceId)],
            controlsText: `Controls the ${group.route}`,
            when: getConnectionSourceWhen(group),
            risk: group.sourceRisk,
        }),
    ];
}

function responseLengthHelp(group) {
    return [
        `${group.key}_response_length`,
        basicHelp({
            selector: selectorFor(group.responseLengthId),
            title: `${group.label} Response Length`,
            short: 'Maximum response length for default/profile routes.',
            controls: [controlFor(group.responseLengthId)],
            controlsText: `Controls the response length cap for the ${group.route}`,
            when: 'if a provider rejects large non-streaming limits or you need shorter summaries.',
            risk: `too low can cut off summaries. ${group.responseDefault}`,
        }),
    ];
}

function profileHelp(group) {
    return [
        `${group.key}_profile`,
        basicHelp({
            selector: selectorFor(group.profileId),
            title: `${group.label} Profile`,
            short: 'Saved SillyTavern connection profile for this route.',
            controls: [controlFor(group.profileId)],
            controlsText: `Controls which saved SillyTavern Connection Profile powers the ${group.route}`,
            when: 'if you selected Connection Profile as the source.',
            risk: 'profile formatting and model choice can change summary quality.',
        }),
    ];
}

function ollamaUrlHelp(group) {
    return [
        `${group.key}_ollama_url`,
        basicHelp({
            selector: selectorFor(group.ollamaUrlId),
            title: `${group.label} Ollama URL`,
            short: 'Ollama server address used by this route.',
            controls: [controlFor(group.ollamaUrlId)],
            controlsText: `Controls the Ollama endpoint used by the ${group.route}`,
            when: 'if your local Ollama server runs somewhere other than localhost:11434.',
            risk: 'a wrong URL or missing CORS setup makes the route fail.',
        }),
    ];
}

function ollamaModelHelp(group) {
    return [
        `${group.key}_ollama_model`,
        basicHelp({
            selector: selectorFor(group.ollamaModelId),
            title: `${group.label} Ollama Model`,
            short: 'Local Ollama model used by this route.',
            controls: [controlFor(group.ollamaModelId)],
            controlsText: `Controls which Ollama model powers the ${group.route}`,
            when: 'if you want a different local summarizer model.',
            risk: 'a small or weak model may miss important memory facts.',
        }),
    ];
}

function openaiUrlHelp(group) {
    return [
        `${group.key}_openai_url`,
        basicHelp({
            selector: selectorFor(group.openaiUrlId),
            title: `${group.label} OpenAI URL`,
            short: 'OpenAI-compatible base URL for this route.',
            controls: [controlFor(group.openaiUrlId)],
            controlsText: `Controls the OpenAI-compatible endpoint used by the ${group.route}`,
            when: 'for OpenRouter, local OpenAI-compatible servers, or another compatible provider.',
            risk: 'the URL should usually end at /v1; a wrong base URL makes requests fail.',
        }),
    ];
}

function openaiKeyHelp(group) {
    return [
        `${group.key}_openai_key`,
        basicHelp({
            selector: selectorFor(group.openaiKeyId),
            title: `${group.label} API Key`,
            short: 'API key for the OpenAI-compatible route.',
            controls: [controlFor(group.openaiKeyId)],
            controlsText: `Controls the API key sent to the ${group.route}`,
            when: 'if your provider requires authentication.',
            risk: 'leaving it empty fails on hosted providers, while saving a key stores it in ST settings.',
        }),
    ];
}

function openaiModelHelp(group) {
    return [
        `${group.key}_openai_model`,
        basicHelp({
            selector: selectorFor(group.openaiModelId),
            title: `${group.label} OpenAI Model`,
            short: 'Model name for the OpenAI-compatible route.',
            controls: [controlFor(group.openaiModelId)],
            controlsText: `Controls which OpenAI-compatible model powers the ${group.route}`,
            when: 'if your provider exposes a different model name.',
            risk: 'typos or unavailable models make requests fail.',
        }),
    ];
}

function openaiMaxTokensHelp(group) {
    return [
        `${group.key}_openai_max_tokens`,
        basicHelp({
            selector: selectorFor(group.openaiMaxTokensId),
            title: `${group.label} Max Tokens`,
            short: 'Output token cap for OpenAI-compatible requests.',
            controls: [controlFor(group.openaiMaxTokensId)],
            controlsText: `Controls the max_tokens value for the ${group.route}`,
            when: 'if your provider needs an explicit output cap.',
            risk: `too low cuts off summaries. ${group.openaiDefault}`,
        }),
    ];
}

function getConnectionSourceShort(group) {
    if (group.key === 'fallback') {
        return 'Backup route after retryable primary failures.';
    }
    if (group.key === 'merge') {
        return 'Optional route for deeper memory merges.';
    }
    return 'Route used for raw chat to Layer 0 summaries.';
}

function getConnectionSourceWhen(group) {
    if (group.key === 'fallback') {
        return 'only if you have a second working route. Leave disabled otherwise.';
    }
    if (group.key === 'merge') {
        return 'if deeper memory merges need a different or stronger model.';
    }
    return 'when the default route is not the best summarizer.';
}

function annotateHelpEntry($settings, key, entry) {
    const $selected = $settings.find(entry.selector).first();
    if (!$selected.length) {
        return;
    }

    const $target = resolveHelpTarget($selected);
    $target.addClass('sc-help-target').attr('data-sc-help-key', key);
    updateShortHint($settings, $target, $selected, entry);
    addHelpIcon($target, $selected);
    addHiddenDescription($settings, key, entry);
    annotateControls($settings, $target, $selected, key, entry);
}

function resolveHelpTarget($selected) {
    const rowSelector = [
        '.sc-row',
        '.sc-setting-row',
        '.sc-toggle-row',
        '.sc-mode-card',
        '.sc-custom-prompt-save-row',
    ].join(', ');

    if ($selected.is(rowSelector)) {
        return $selected;
    }

    const $row = $selected.closest(rowSelector);
    return $row.length ? $row : $selected;
}

function updateShortHint($settings, $target, $selected, entry) {
    const $hintHost = getHintHost($target, $selected);
    if ($hintHost.length) {
        const $hint = getOrCreateHint($hintHost);
        $hint.text(entry.short);
        $hintHost.children('.sc-hint').not($hint).remove();
        return;
    }

    const $rowHint = getOrCreateRowHint($settings, $target);
    $rowHint.text(entry.short);
}

function getHintHost($target, $selected) {
    const $copy = $target.find('.sc-toggle-copy').first();
    if ($copy.length) {
        return $copy;
    }
    if ($selected.is('label')) {
        return $selected;
    }
    const $label = $target.find('label').first();
    return $label.length ? $label : $();
}

function getOrCreateHint($hintHost) {
    const $existing = $hintHost.children('.sc-hint, small').first();
    if ($existing.length) {
        return $existing.addClass('sc-hint');
    }
    return $('<small class="sc-hint"></small>').appendTo($hintHost);
}

function getOrCreateRowHint($settings, $target) {
    const key = String($target.attr('data-sc-help-key') || '');
    const selector = `.sc-hint.sc-help-row-hint[data-sc-help-key="${key}"]`;
    const $existing = $settings.find(selector).first();
    if ($existing.length) {
        return $existing;
    }
    return $('<small class="sc-hint sc-help-row-hint"></small>')
        .attr('data-sc-help-key', key)
        .insertAfter($target);
}

function addHelpIcon($target, $selected) {
    if ($target.find('.sc-help-icon').length) {
        return;
    }

    const $title = getTitleTarget($target, $selected);
    const $icon = $('<span class="sc-help-icon fa-solid fa-circle-question"></span>').attr(
        'aria-hidden',
        'true',
    );

    if ($title.length) {
        $icon.insertAfter($title);
        return;
    }
    $icon.insertAfter($selected);
}

function getTitleTarget($target, $selected) {
    const $title = $target.find('.sc-toggle-title').first();
    if ($title.length) {
        return $title;
    }
    if ($selected.is('label')) {
        return $selected.children('span').first();
    }
    const $labelTitle = $target.find('label > span').first();
    return $labelTitle.length ? $labelTitle : $();
}

function addHiddenDescription($settings, key, entry) {
    const id = getDescriptionId(key);
    const $existing = $settings.find(`#${id}`).first();
    const text = `${entry.title}. ${entry.detail}`;
    if ($existing.length) {
        $existing.text(text);
        return;
    }
    $('<span class="sc-sr-only"></span>').attr('id', id).text(text).appendTo($settings);
}

function annotateControls($settings, $target, $selected, key, entry) {
    const controls = getControlSelectors($target, $selected, entry);
    const descId = getDescriptionId(key);

    for (const selector of controls) {
        $settings.find(selector).each(function () {
            const $control = $(this);
            addDescribedBy($control, descId);
            $control.attr('data-sc-help-control', key);
        });
    }
}

function getControlSelectors($target, $selected, entry) {
    if (entry.controls?.length) {
        return entry.controls;
    }
    if ($selected.is('label[for]')) {
        return [controlFor($selected.attr('for'))];
    }

    const $label = $target.find('label[for]').first();
    if ($label.length) {
        return [controlFor($label.attr('for'))];
    }
    return [];
}

function addDescribedBy($control, descId) {
    const existing = String($control.attr('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean);
    if (!existing.includes(descId)) {
        existing.push(descId);
    }
    $control.attr('aria-describedby', existing.join(' '));
}

function getDescriptionId(key) {
    return `sc_help_desc_${String(key).replaceAll(/[^a-z0-9_-]/gi, '_')}`;
}

function getHelpTooltip($settings) {
    $settings.children('.sc-help-tooltip').remove();

    let $tooltip = $(`#${HELP_TOOLTIP_ID}`).first();
    if ($tooltip.length) {
        return $tooltip.empty();
    }

    $tooltip = $('<div class="sc-help-tooltip" role="tooltip"></div>').attr('aria-hidden', 'true');
    $tooltip.attr('id', HELP_TOOLTIP_ID).appendTo('body');
    return $tooltip;
}

function bindHelpTooltip($settings, $tooltip) {
    $settings.off(HELP_EVENT_NS);
    $(document).off(HELP_EVENT_NS);
    $(window).off(HELP_EVENT_NS);

    $settings.on(`mouseenter${HELP_EVENT_NS}`, HELP_TARGET_SELECTOR, function () {
        showTooltip($settings, $tooltip, $(this), this);
    });
    $settings.on(`mouseleave${HELP_EVENT_NS}`, HELP_TARGET_SELECTOR, () => hideTooltip($tooltip));
    $settings.on(`focusin${HELP_EVENT_NS}`, HELP_FOCUS_SELECTOR, function () {
        const $target = getHelpTarget($(this));
        showTooltip($settings, $tooltip, $target, this);
    });
    $settings.on(`focusout${HELP_EVENT_NS}`, HELP_FOCUS_SELECTOR, () => hideTooltip($tooltip));
    $settings.on(`click${HELP_EVENT_NS}`, '.sc-tab-button, .sc-prompt-segment-button', () =>
        hideTooltip($tooltip),
    );
    $settings.on(`scroll${HELP_EVENT_NS}`, () => hideTooltip($tooltip));
    $(window).on(`scroll${HELP_EVENT_NS} resize${HELP_EVENT_NS}`, () => hideTooltip($tooltip));
    $(document).on(`keydown${HELP_EVENT_NS}`, (event) => {
        if (event.key === 'Escape') {
            hideTooltip($tooltip);
        }
    });
}

function getHelpTarget($element) {
    if ($element.is(HELP_TARGET_SELECTOR)) {
        return $element;
    }
    const $target = $element.closest(HELP_TARGET_SELECTOR);
    return $target.length ? $target : $element;
}

function showTooltip($settings, $tooltip, $target, anchor) {
    const key = String(
        $target.attr('data-sc-help-key') || $target.attr('data-sc-help-control') || '',
    );
    const entry = SETTINGS_HELP[key];
    if (!entry) {
        return;
    }

    $tooltip
        .empty()
        .append($('<div class="sc-help-tooltip-title"></div>').text(entry.title))
        .append($('<div class="sc-help-tooltip-body"></div>').text(entry.detail))
        .attr('aria-hidden', 'false')
        .css({ display: 'block', visibility: 'hidden' });

    positionTooltip($settings, $tooltip, anchor);
    $tooltip.css('visibility', 'visible');
}

function hideTooltip($tooltip) {
    $tooltip.attr('aria-hidden', 'true').hide();
}

function positionTooltip($settings, $tooltip, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const settingsRect = $settings[0].getBoundingClientRect();
    const tooltipWidth = $tooltip.outerWidth() || 280;
    const tooltipHeight = $tooltip.outerHeight() || 80;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 480;
    const position = calculateHelpTooltipPosition({
        anchorRect,
        settingsRect,
        tooltipWidth,
        tooltipHeight,
        viewportWidth,
        viewportHeight,
    });

    $tooltip.css({
        left: `${position.left}px`,
        top: `${position.top}px`,
    });
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
