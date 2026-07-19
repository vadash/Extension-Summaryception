import { CONNECTION_HELP_ENTRIES } from './settings-help-data.js';

const HELP_EVENT_NS = '.summaryceptionSettingsHelp';
const HELP_TOOLTIP_ID = 'sc_help_tooltip';
const HELP_TARGET_SELECTOR = '.sc-help-target';
const HELP_ICON_SELECTOR = '.sc-help-icon';
const HELP_FOCUS_SELECTOR = [
    '.sc-help-target',
    '.sc-help-target input',
    '.sc-help-target select',
    '.sc-help-target textarea',
    '[data-sc-help-control]',
].join(', ');
const HELP_TOOLTIP_DELAY_MS = 500;

const selectorFor = (id) => `label[for="${id}"]`;
const controlFor = (id) => `#${id}`;

let helpTooltipTimer = null;

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
    detail: `${controlsText} ${when} ${risk}`,
    controls,
});

const MEMORY_MODE_HELP = Object.freeze({
    standard: {
        title: 'Standard',
        short: 'Summarizes overflow as it comes, so the main prompt stays smaller and steadier.',
        controlsText: 'Toggles the rolling verbatim window plus continuous summaries on or off.',
        when: 'Turn it on when you want steadier context size and higher recall in a smaller total context, or when your provider has no real prompt caching.',
        risk: 'You pay full input price for the changing prompt on every turn.',
    },
    cache: {
        title: 'Cache Friendly',
        short: 'Uses a bigger 32k live window for providers that discount cached input.',
        controlsText:
            'Locks a stable memory prefix in place and holds off flushing until the live cache window fills.',
        when: 'Use it when your provider supports prompt caching and bills cached tokens at a steep discount.',
        risk: 'Total context grows larger (memory plus 32k), and a manual summarize run can wipe your cache savings.',
    },
});

const memoryModeHelp = ({ selector, controls, mode }) =>
    basicHelp({
        selector,
        controls,
        ...MEMORY_MODE_HELP[mode],
    });

const HELP_ENTRIES = [
    [
        'enabled',
        basicHelp({
            selector: selectorFor('sc_mode_easy'),
            title: 'Summaryception Mode',
            short: 'Choose Off, Easy, or Advanced operation.',
            controls: [
                controlFor('sc_mode_off'),
                controlFor('sc_mode_easy'),
                controlFor('sc_mode_advanced'),
            ],
            controlsText:
                'Lets you turn Summaryception off, run it with the safe Easy defaults, or open up all the Advanced settings.',
            when: 'Use it when you want this chat to keep layered memory.',
            risk: 'Off stops memory injection and background summarizing until another mode is picked.',
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
                'Decides whether SillyTavern regex scripts run on the text before it reaches the summarizer.',
            when: 'Turn it on if your main model also sees the regex-cleaned text.',
            risk: 'Turn it off and summaries can end up remembering text your RP model never actually saw.',
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
                'Decides whether summaries drop Han ideographs and throw out heavily contaminated replies.',
            when: 'Reach for it if your summarizer sometimes slips Chinese text into memory.',
            risk: 'Legit Chinese names and text get stripped from committed memory too.',
        }),
    ],
    [
        'mask_user_role_as_assistant',
        basicHelp({
            selector: selectorFor('sc_mask_user_role_as_assistant'),
            title: 'Mask User Role',
            short: "Send your turns as the AI's words so the model quits handing your character plot armor.",
            controls: [
                controlFor('sc_mask_user_role_as_assistant'),
                controlFor('sc_mask_user_role_mode'),
            ],
            controlsText:
                'This relabels your chat turns as the AI\'s own words before the request leaves, so the model quits handing your character plot armor. Chat-completion models are RLHF-trained to treat whatever sits in the user role as a real person to please and keep safe, which is why your character never truly loses. Flip your turns to the assistant role and the whole log reads like one narrator telling a story, so you become just another character who can get hurt, surprised, or told no. It only touches the outgoing request; your saved chat stays exactly as you wrote it. Works best when you roleplay in third person and edit your preset so it never says "user" or "you". The modes: marker first adds a throwaway user line at the top for APIs that demand one; no marker turns every turn into the AI (request-only, zero user messages); marker last puts that throwaway user line at the end; keep the final user block leaves your last message as user, which is handy when another extension such as Rabbit-Response-Team injects its instruction there.',
            when: 'Reach for it when you want the model to stop shielding your character and just play the scene straight.',
            risk: 'providers may normalize or reject unusual role layouts or synthetic marker messages, and a no-marker request with zero user messages can be refused outright — that is exactly what the marker modes are for.',
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
            meaning:
                'How much recent chat stays word-for-word before older turns get summarized into Layer 0.',
            higher: 'keeps more exact recent chat but eats more context.',
            lower: 'summarizes sooner and frees up room for memory.',
            defaultText:
                '22k; Cache Friendly bumps this to 32k and can save ~70% per turn on caching providers.',
        }),
    ],
    [
        'memory_token_budget',
        sliderHelp({
            selector: selectorFor('sc_memory_token_budget'),
            title: 'Injected Memory Budget',
            short: 'Maximum memory block size that goes to the model.',
            controls: [
                controlFor('sc_memory_token_budget'),
                controlFor('sc_memory_token_budget_val'),
            ],
            meaning:
                'The maximum ceiling on committed Summaryception memory sent via direct injection or the macro; real usage can sit below it after compression and promotion cycles.',
            higher: 'holds more detailed memory before promotion pressure builds.',
            lower: 'promotes and compresses memory sooner, and 4k is the hard ceiling where consolidation turns aggressive.',
            defaultText: '10k.',
        }),
    ],
    [
        'advanced_model_context',
        sliderHelp({
            selector: selectorFor('sc_advanced_model_context'),
            title: 'Model Context',
            short: 'Summarizer capacity; auto-tunes batch sizes.',
            controls: [
                controlFor('sc_advanced_model_context'),
                controlFor('sc_advanced_model_context_val'),
            ],
            meaning: 'Sets the source cap and the batch trigger for Layer 0 summarizer calls.',
            higher: 'allows bigger batches on large-context models.',
            lower: 'keeps each summarizer request smaller.',
            defaultText: '48k; overrides live under Expert Tuning.',
        }),
    ],
    [
        'layer0_summary_token_target',
        sliderHelp({
            selector: selectorFor('sc_layer0_summary_token_target'),
            title: 'Narrative Target Size',
            short: 'Target size for each Layer 0 narrative section.',
            controls: [
                controlFor('sc_layer0_summary_token_target'),
                controlFor('sc_layer0_summary_token_target_val'),
            ],
            meaning:
                'The target size for the [NARRATIVE] section of a single Layer 0 summary. Auto-derived from Model context; override it here. [STATE] keeps its own fixed 200-token soft target and 300-token hard maximum.',
            higher: 'preserves more chronological detail in each Layer 0 narrative.',
            lower: 'compresses each narrative harder and leaves more room in the memory budget.',
            defaultText: '200; auto-derived from Model context.',
        }),
    ],
    [
        'max_l0_source_tokens',
        sliderHelp({
            selector: selectorFor('sc_max_l0_source_tokens'),
            title: 'Max Source per Call',
            short: 'Hard ceiling for raw chat sent in one Layer 0 request.',
            controls: [
                controlFor('sc_max_l0_source_tokens'),
                controlFor('sc_max_l0_source_tokens_val'),
            ],
            meaning:
                'The maximum raw-chat source size sent in a single Layer 0 summarizer call. Auto-derived from Model context; override it here.',
            higher: 'allows bigger batches for models with more context.',
            lower: 'keeps each summarizer request smaller and safer.',
            defaultText: '24k, inside an 8k-64k range; auto-derived from Model context.',
        }),
    ],
    [
        'min_summary_budget',
        sliderHelp({
            selector: selectorFor('sc_min_summary_budget'),
            title: 'Batch Trigger Size',
            short: 'How much overflow text to collect before short batches run.',
            controls: [
                controlFor('sc_min_summary_budget'),
                controlFor('sc_min_summary_budget_val'),
            ],
            meaning:
                'The minimum overflow size before a normal Layer 0 batch is worth summarizing; it cannot exceed Max Source per Call. Auto-derived from Model context; override it here.',
            higher: 'waits for bigger chunks and makes fewer summarizer calls.',
            lower: 'summarizes smaller chunks sooner.',
            defaultText: '16k, with a fixed 4k-32k control range; auto-derived from Model context.',
        }),
    ],
    [
        'min_summary_turns',
        sliderHelp({
            selector: selectorFor('sc_min_summary_turns'),
            title: 'Minimum Summary Turns',
            short: 'Fewest assistant turns needed before a batch can run.',
            controls: [controlFor('sc_min_summary_turns'), controlFor('sc_min_summary_turns_val')],
            meaning:
                'The minimum assistant-turn count before a budget-ready Layer 0 batch can run.',
            higher: 'waits for more conversation before summarizing.',
            lower: 'lets shorter batches get summarized.',
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
            meaning: 'The maximum assistant-turn count in a single Layer 0 summary request.',
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
            meaning: 'The maximum snippets a layer should hold before promotion pressure kicks in.',
            higher: 'keeps more separate memories in each layer.',
            lower: 'merges memories down into deeper layers sooner.',
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
            meaning:
                'How many of the oldest snippets get bundled together when a layer promotes memory deeper.',
            higher: 'makes fewer and larger promotion merges, which helps in 2000+ message chats.',
            lower: 'makes smaller promotion merges more often, better for shorter chats.',
            defaultText: '3.',
        }),
    ],
    [
        'memory_mode_standard',
        memoryModeHelp({
            selector: selectorFor('sc_memory_mode_standard'),
            controls: [controlFor('sc_memory_mode_standard')],
            mode: 'standard',
        }),
    ],
    [
        'memory_mode_cache',
        memoryModeHelp({
            selector: selectorFor('sc_memory_mode_cache'),
            controls: [controlFor('sc_memory_mode_cache')],
            mode: 'cache',
        }),
    ],
    [
        'custom_memory_position',
        basicHelp({
            selector: selectorFor('sc_custom_memory_position'),
            title: 'Memory Position',
            short: 'Where Summaryception memory is placed in the ST prompt.',
            controls: [controlFor('sc_custom_memory_position')],
            controlsText:
                'Picks whether the combined memory block goes in directly or shows up as the {{summaryception_memory}} macro.',
            when: 'Use it when your prompt layout needs the memory in a specific spot.',
            risk: 'Memory placed too late, too early, or only inside an unused macro can get ignored by the model.',
        }),
    ],
    [
        'custom_memory_role',
        basicHelp({
            selector: selectorFor('sc_custom_memory_role'),
            title: 'Memory Role',
            short: 'Message role used when memory is injected as chat.',
            controls: [controlFor('sc_custom_memory_role')],
            controlsText: 'Sets the message role for custom memory when it is sent as chat.',
            when: 'Turn it on if a provider treats system, user, and assistant messages differently.',
            risk: 'The wrong role makes memory read like instructions, or like dialogue.',
        }),
    ],
    [
        'custom_memory_depth',
        basicHelp({
            selector: selectorFor('sc_custom_memory_depth'),
            title: 'Chat Depth',
            short: 'How far back memory is inserted when using In Chat.',
            controls: [controlFor('sc_custom_memory_depth')],
            controlsText:
                'Sets how far back from the latest turn the custom In Chat memory shows up.',
            when: 'Use it only when Memory Position is set to In Chat.',
            risk: 'A bad depth puts memory too close to or too far from the latest turn.',
        }),
    ],
    ...CONNECTION_HELP_ENTRIES,
    [
        'easy_memory_mode_standard',
        memoryModeHelp({
            selector: selectorFor('sc_easy_memory_mode_standard'),
            controls: [controlFor('sc_easy_memory_mode_standard')],
            mode: 'standard',
        }),
    ],
    [
        'easy_memory_mode_cache',
        memoryModeHelp({
            selector: selectorFor('sc_easy_memory_mode_cache'),
            controls: [controlFor('sc_easy_memory_mode_cache')],
            mode: 'cache',
        }),
    ],
    [
        'layer0_system_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_summarizer_system_prompt_preset'),
            title: 'Layer 0 System Preset',
            short: 'Choose the Layer 0 system prompt source.',
            controls: [controlFor('sc_summarizer_system_prompt_preset')],
            controlsText:
                'Picks between the default Layer 0 system prompt and your own custom text.',
            when: 'Use it when you want to change the role instruction for Layer 0 summaries.',
            risk: 'Swapping system instructions can change how summaries are structured.',
        }),
    ],
    [
        'layer0_system_prompt',
        basicHelp({
            selector: selectorFor('sc_summarizer_system_prompt'),
            title: 'Layer 0 System Prompt',
            short: 'Instruction style for raw-chat summaries.',
            controls: [controlFor('sc_summarizer_system_prompt')],
            controlsText:
                'Sets the system instruction that goes out with raw chat summarization requests.',
            when: 'Turn it on if the summarizer needs a different role or a stricter output style.',
            risk: 'Too much instruction makes summaries verbose or inconsistent.',
        }),
    ],
    [
        'prompt_preset',
        basicHelp({
            selector: selectorFor('sc_prompt_preset'),
            title: 'Layer 0 User Preset',
            short: 'Choose the Layer 0 user-prompt template.',
            controls: [controlFor('sc_prompt_preset')],
            controlsText:
                'Picks between the default Layer 0 user prompt and your own custom version.',
            when: 'Use it when switching between the default narrative memory and your own custom prompt.',
            risk: 'Changing presets changes what future summaries end up keeping.',
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
                'Sets the user prompt for raw-chat summaries; it can use the {{player_name}}, {{context_str}}, and {{story_txt}} variables.',
            when: 'Reach for it if the current preset keeps missing the facts you care about.',
            risk: 'Missing variables or a request for long output can break compact memory.',
        }),
    ],
    [
        'layer0_repair_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_summarizer_repair_prompt_preset'),
            title: 'Layer 0 Repair Preset',
            short: 'Choose the Layer 0 repair prompt source.',
            controls: [controlFor('sc_summarizer_repair_prompt_preset')],
            controlsText:
                'Picks between the default and a custom repair prompt for Layer 0 validation retries.',
            when: 'Turn it on if invalid Layer 0 output needs stricter retry instructions.',
            risk: 'A weak repair prompt keeps failing output validation.',
        }),
    ],
    [
        'layer0_repair_prompt',
        basicHelp({
            selector: selectorFor('sc_summarizer_repair_prompt'),
            title: 'Layer 0 Repair Prompt',
            short: 'Template used after invalid Layer 0 output.',
            controls: [controlFor('sc_summarizer_repair_prompt')],
            controlsText:
                'Sets the user prompt for Layer 0 validation repair retries; it can use the {{player_name}}, {{context_str}}, and {{story_txt}} variables.',
            when: 'Use it if the default repair prompt is not strict enough for your summarizer.',
            risk: 'Missing section instructions can stop repair retries from succeeding.',
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
                'Sets the wrapper that goes around Summaryception memory, and it has to include the {{summary}} variable.',
            when: 'Reach for it if your model follows a different memory tag or framing better.',
            risk: 'Drop the {{summary}} variable and no memory text gets injected at all.',
        }),
    ],
    [
        'promotion_system_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_promotion_system_prompt_preset'),
            title: 'Promotion System Preset',
            short: 'Choose the Layer 1+ system prompt source.',
            controls: [controlFor('sc_promotion_system_prompt_preset')],
            controlsText:
                'Picks between the default Layer 1+ system prompt and your own custom text.',
            when: 'Use it when you want to change the role instruction for deeper memory merges.',
            risk: 'Changing system instructions can affect promotion compression.',
        }),
    ],
    [
        'promotion_system_prompt',
        basicHelp({
            selector: selectorFor('sc_promotion_system_prompt'),
            title: 'Promotion System Prompt',
            short: 'Instruction style for deeper memory merges.',
            controls: [controlFor('sc_promotion_system_prompt')],
            controlsText:
                'Sets the system instruction used when Layer 1+ memories get merged together.',
            when: 'Turn it on if promoted memories need a different compression style.',
            risk: 'Bad merge instructions can erase durable facts.',
        }),
    ],
    [
        'promotion_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_promotion_prompt_preset'),
            title: 'Layer 1+ User Preset',
            short: 'Choose the Layer 1+ merge user-prompt template.',
            controls: [controlFor('sc_promotion_prompt_preset')],
            controlsText:
                'Picks between the default Layer 1+ user prompt and your own custom version.',
            when: 'Use it when switching between the default promotion memory and your own custom prompt.',
            risk: 'Changing presets can change how deeper summaries preserve durable facts.',
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
                'Sets the user prompt for Layer 1+ promotion; it can use the {{player_name}}, {{context_str}}, and {{story_txt}} variables.',
            when: 'Reach for it if deeper memories keep too much detail or lose key state.',
            risk: 'Weak instructions create bloated or lossy meta-summaries.',
        }),
    ],
    [
        'promotion_repair_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_promotion_repair_prompt_preset'),
            title: 'Layer 1+ Repair Preset',
            short: 'Choose the Layer 1+ repair prompt source.',
            controls: [controlFor('sc_promotion_repair_prompt_preset')],
            controlsText:
                'Picks between the default and a custom repair prompt for failed Layer 1+ compression.',
            when: 'Use it if promotion repair needs a different compression style.',
            risk: 'A weak repair prompt keeps promoted memories too large.',
        }),
    ],
    [
        'promotion_repair_prompt',
        basicHelp({
            selector: selectorFor('sc_promotion_repair_prompt'),
            title: 'Layer 1+ Repair Prompt',
            short: 'Template used for failed promotion compression repair.',
            controls: [controlFor('sc_promotion_repair_prompt')],
            controlsText:
                'Sets the user prompt for Layer 1+ promotion repair; it can use the {{player_name}}, {{context_str}}, {{story_txt}}, and {{source_state}} variables.',
            when: 'Turn it on if repaired promotions still keep too much detail.',
            risk: 'Bad repair instructions can erase durable continuity.',
        }),
    ],
    [
        'strip_patterns',
        basicHelp({
            selector: selectorFor('sc_strip_patterns'),
            title: 'Strip Patterns',
            short: 'Text patterns removed from summarizer responses.',
            controls: [controlFor('sc_strip_patterns')],
            controlsText:
                'Sets the one-per-line patterns that get stripped from generated summary text.',
            when: 'Use it if a summarizer keeps adding unwanted tags or thinking markers.',
            risk: 'Overbroad patterns can carve out useful memory text.',
        }),
    ],
    [
        'debug_mode',
        basicHelp({
            selector: selectorFor('sc_debug_mode'),
            title: 'Debug Mode',
            short: 'Show extra Summaryception console logs.',
            controls: [controlFor('sc_debug_mode')],
            controlsText: 'Turns verbose Summaryception diagnostic logging on or off.',
            when: 'Reach for it while troubleshooting behavior.',
            risk: 'The logs get noisy and may mention chat-derived state.',
        }),
    ],
    [
        'trace_mode',
        basicHelp({
            selector: selectorFor('sc_trace_mode'),
            title: 'Trace Mode',
            short: 'Show detailed flow logs when Debug Mode is on.',
            controls: [controlFor('sc_trace_mode')],
            controlsText: 'Turns on the most detailed Summaryception flow logging.',
            when: 'Use it only when Debug Mode is on and you need step-by-step behavior.',
            risk: 'Trace logs are very noisy.',
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
                'Decides whether the full final system and user prompt content sent to the summarizer gets logged.',
            when: 'Turn it on only when diagnosing prompt quality.',
            risk: 'The browser console may hold private chat text.',
        }),
    ],
    [
        'prompt_output_log_mode',
        basicHelp({
            selector: selectorFor('sc_prompt_output_log_mode'),
            title: 'Log LLM Outputs',
            short: 'Print cleaned summarizer replies to the console.',
            controls: [controlFor('sc_prompt_output_log_mode')],
            controlsText: 'Decides whether cleaned summarizer replies and errors get logged.',
            when: 'Use it only when diagnosing provider output or cleanup behavior.',
            risk: 'The browser console may hold private chat text.',
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
    annotateControls({ $settings, $target, $selected, key, entry });
}

function resolveHelpTarget($selected) {
    const rowSelector = ['.sc-row', '.sc-setting-row', '.sc-toggle-row', '.sc-mode-card'].join(
        ', ',
    );

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

function annotateControls({ $settings, $target, $selected, key, entry }) {
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
    clearTooltipTimer();

    const hide = () => {
        clearTooltipTimer();
        hideTooltip($tooltip);
    };

    $settings.on(`mouseenter${HELP_EVENT_NS}`, HELP_ICON_SELECTOR, function () {
        clearTooltipTimer();
        const icon = this;
        helpTooltipTimer = setTimeout(() => {
            helpTooltipTimer = null;
            const $target = getHelpTarget($(icon));
            showTooltip($settings, $tooltip, $target, icon);
        }, HELP_TOOLTIP_DELAY_MS);
    });
    $settings.on(`mouseleave${HELP_EVENT_NS}`, HELP_ICON_SELECTOR, hide);
    $settings.on(`focusout${HELP_EVENT_NS}`, HELP_FOCUS_SELECTOR, hide);
    $settings.on(`click${HELP_EVENT_NS}`, '.sc-tab-button, .sc-prompt-segment-button', hide);
    $settings.on(`scroll${HELP_EVENT_NS}`, hide);
    $(window).on(`scroll${HELP_EVENT_NS} resize${HELP_EVENT_NS}`, hide);
    $(document).on(`keydown${HELP_EVENT_NS}`, (event) => {
        if (event.key === 'Escape') {
            hide();
        }
    });
}

function clearTooltipTimer() {
    if (helpTooltipTimer !== null) {
        clearTimeout(helpTooltipTimer);
        helpTooltipTimer = null;
    }
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
