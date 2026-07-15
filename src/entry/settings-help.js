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
    detail: `${controlsText} Change it ${when} Main risk: ${risk}`,
    controls,
});

const MEMORY_MODE_HELP = Object.freeze({
    standard: {
        title: 'Standard',
        short: 'Keeps the main prompt smaller and steadier by summarizing overflow continuously.',
        controlsText:
            'Controls whether Summaryception uses the regular rolling verbatim window and continuous summaries.',
        when: 'when you want steadier context size, higher recall at smaller total context, or your provider lacks useful prompt caching.',
        risk: 'you pay full input price for the changing prompt on every turn.',
    },
    cache: {
        title: 'Cache Friendly',
        short: 'Uses a larger 32k live window for providers that discount cached input.',
        controlsText:
            'Controls whether the prompt keeps a stable memory prefix and delays flushing until the live cache window fills.',
        when: 'when your provider supports prompt caching and bills cached tokens at a steep discount.',
        risk: 'total context is larger (memory + 32k), and manual summarization can reset cache savings.',
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
                'Controls whether Summaryception is off, uses safe Easy controls, or exposes all Advanced settings.',
            when: 'when you want this chat to use layered memory.',
            risk: 'Off stops memory injection and background summarizing until another mode is selected.',
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
        'mask_user_role_as_assistant',
        basicHelp({
            selector: selectorFor('sc_mask_user_role_as_assistant'),
            title: 'Mask User Role',
            short: 'Send text-only user prompt blocks as assistant blocks.',
            controls: [controlFor('sc_mask_user_role_as_assistant')],
            controlsText:
                'Controls whether final text-only user-role request messages are rewritten to assistant-role messages before the RP model call.',
            when: 'when you want roleplay prompts to hide the user/assistant split from chat-completion models.',
            risk: 'this does not edit saved chat, names, or prompt text; prompts that mention the user still reveal that framing, and some providers may normalize or reject unusual role layouts.',
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
            defaultText:
                '22k; Cache Friendly switches this to 32k and can save ~70% per turn on caching providers.',
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
                'Maximum ceiling for committed Summaryception memory sent through direct injection or the macro; actual use may sit below it after compression and promotion cycles.',
            higher: 'keeps more detailed memory before promotion pressure rises.',
            lower: 'promotes and compresses memory sooner; 4k is the hard ceiling where consolidation becomes aggressive.',
            defaultText: '10k.',
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
                'Target size for the [NARRATIVE] section of one Layer 0 summary. [STATE] keeps a separate fixed 200-token soft target and 300-token hard maximum.',
            higher: 'keeps more chronological detail in each Layer 0 narrative.',
            lower: 'compresses each narrative harder and leaves more memory budget.',
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
                'Controls whether the combined memory block is inserted directly or exposed as {{summaryception_memory}}.',
            when: 'when your prompt layout needs a specific location.',
            risk: 'placing memory too late, too early, or only in an unused macro can make the model ignore it.',
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
                'Controls whether the Layer 0 system prompt uses the default or custom text.',
            when: 'when changing the role instruction for Layer 0 summaries.',
            risk: 'changing system instructions can affect summary structure.',
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
                'Controls the system instruction sent with raw chat summarization requests.',
            when: 'if the summarizer needs a different role or stricter output style.',
            risk: 'too much instruction can make summaries verbose or inconsistent.',
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
                'Controls whether the Layer 0 user prompt uses the default or custom text.',
            when: 'when switching between default narrative memory and your own custom prompt.',
            risk: 'changing presets can change what future summaries preserve.',
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
        'layer0_repair_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_summarizer_repair_prompt_preset'),
            title: 'Layer 0 Repair Preset',
            short: 'Choose the Layer 0 repair prompt source.',
            controls: [controlFor('sc_summarizer_repair_prompt_preset')],
            controlsText:
                'Controls whether Layer 0 validation retries use the default or custom repair prompt.',
            when: 'if invalid Layer 0 output needs stricter retry instructions.',
            risk: 'weak repair prompts can keep failing output validation.',
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
                'Controls the user prompt for Layer 0 validation repair retries and can use {{player_name}}, {{context_str}}, and {{story_txt}}.',
            when: 'if the default repair prompt is not strict enough for your summarizer.',
            risk: 'missing required section instructions can prevent repair retries from succeeding.',
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
                'Controls the wrapper around Summaryception memory and must include {{summary}}.',
            when: 'if your model follows a different memory tag or framing better.',
            risk: 'removing {{summary}} means no memory text is injected.',
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
                'Controls whether the Layer 1+ system prompt uses the default or custom text.',
            when: 'when changing the role instruction for deeper memory merges.',
            risk: 'changing system instructions can affect promotion compression.',
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
            title: 'Layer 1+ User Preset',
            short: 'Choose the Layer 1+ merge user-prompt template.',
            controls: [controlFor('sc_promotion_prompt_preset')],
            controlsText:
                'Controls whether the Layer 1+ user prompt uses the default or custom text.',
            when: 'when switching between default promotion memory and your own custom prompt.',
            risk: 'changing presets can change how deeper summaries preserve durable facts.',
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
        'promotion_repair_prompt_preset',
        basicHelp({
            selector: selectorFor('sc_promotion_repair_prompt_preset'),
            title: 'Layer 1+ Repair Preset',
            short: 'Choose the Layer 1+ repair prompt source.',
            controls: [controlFor('sc_promotion_repair_prompt_preset')],
            controlsText:
                'Controls whether failed Layer 1+ compression repair uses the default or custom repair prompt.',
            when: 'if promotion repair needs a different compression style.',
            risk: 'weak repair prompts can keep promoted memories too large.',
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
                'Controls the user prompt for Layer 1+ promotion repair and can use {{player_name}}, {{context_str}}, {{story_txt}}, and {{source_state}}.',
            when: 'if repaired promotions still keep too much detail.',
            risk: 'bad repair instructions can erase durable continuity.',
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
