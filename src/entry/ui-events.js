import {
    MEMORY_MODES,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    defaultSettings,
} from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { error, warn } from '../foundation/logger.js';
import {
    bumpSummaryStoreMutationEpoch,
    getSettings,
    saveSettings,
    getChatStore,
} from '../foundation/state.js';
import { ghostMessagesUpTo, unghostAllMessages } from '../core/ghosting.js';
import {
    abortSummarization,
    getIsSummarizing,
    hasActiveAbortController,
    maybeSummarizeTurns,
    runCatchup,
    runSlopBreaker,
} from '../core/summarizer.js';
import { getSlopBreakerPlan } from '../core/slop-breaker.js';
import { getLayer0OverflowPlan } from '../core/verbatim-window.js';
import { updateInjection } from '../features/injection.js';
import { persistAndRefresh } from '../features/persist.js';
import { clearSummaryceptionMemory } from '../features/memory.js';
import { updateUI, syncPayloadSchematic } from './ui.js';
import {
    clearManualProgressToast,
    confirmSlopBreaker,
    createManualProgressToast,
    showCatchupOutcome,
    showSlopBreakerNoop,
    showSlopBreakerOutcome,
    updateManualProgressToast,
} from './ui-dialogs.js';
import {
    SETTING_SLIDER_SELECTOR,
    bindDocumentSetting,
    bindSliderSettingPairs,
    readChecked,
    readIntegerOrZero,
    readString,
} from './ui-bind.js';

const PROMPT_FIELDS = [
    {
        presetSelect: '#sc_summarizer_system_prompt_preset',
        textarea: '#sc_summarizer_system_prompt',
        presetKey: 'summarizerSystemPromptPreset',
        settingKey: 'summarizerSystemPrompt',
        presets: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
        defaultPreset: defaultSettings.summarizerSystemPromptPreset,
    },
    {
        presetSelect: '#sc_prompt_preset',
        textarea: '#sc_summarizer_user_prompt',
        presetKey: 'promptPreset',
        settingKey: 'summarizerUserPrompt',
        presets: PROMPT_PRESETS,
        defaultPreset: defaultSettings.promptPreset,
    },
    {
        presetSelect: '#sc_summarizer_repair_prompt_preset',
        textarea: '#sc_summarizer_repair_prompt',
        presetKey: 'summarizerRepairPromptPreset',
        settingKey: 'summarizerRepairPrompt',
        presets: SUMMARIZER_REPAIR_PROMPT_PRESETS,
        defaultPreset: defaultSettings.summarizerRepairPromptPreset,
    },
    {
        presetSelect: '#sc_promotion_system_prompt_preset',
        textarea: '#sc_promotion_system_prompt',
        presetKey: 'promotionSystemPromptPreset',
        settingKey: 'promotionSystemPrompt',
        presets: PROMOTION_SYSTEM_PROMPT_PRESETS,
        defaultPreset: defaultSettings.promotionSystemPromptPreset,
    },
    {
        presetSelect: '#sc_promotion_prompt_preset',
        textarea: '#sc_promotion_user_prompt',
        presetKey: 'promotionPromptPreset',
        settingKey: 'promotionUserPrompt',
        presets: PROMOTION_PROMPT_PRESETS,
        defaultPreset: defaultSettings.promotionPromptPreset,
    },
    {
        presetSelect: '#sc_promotion_repair_prompt_preset',
        textarea: '#sc_promotion_repair_prompt',
        presetKey: 'promotionRepairPromptPreset',
        settingKey: 'promotionRepairPrompt',
        presets: PROMOTION_REPAIR_PROMPT_PRESETS,
        defaultPreset: defaultSettings.promotionRepairPromptPreset,
    },
];

// Event bindings

/**
 * Bind document event handlers for the Summaryception UI.
 * @returns {void}
 */
export function bindUIEvents() {
    bindToggleHandlers();
    bindMemoryModeHandlers();
    bindSliderHandlers();
    bindTextareaHandlers();
    bindClickHandlers();
    bindPromptProfileHandlers();
}

/**
 * Bind change handlers for toggle-style settings.
 * @returns {void}
 */
function bindToggleHandlers() {
    $(document).on('change', '#sc_enabled', function () {
        const s = getSettings();
        s.enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
        updateUI();

        if (s.enabled) {
            requestAutoSummaryRefresh('enabled');
        }
    });

    /** @type {Array<{ selector: string, key: string }>} */
    const toggles = [
        { selector: '#sc_debug_mode', key: 'debugMode' },
        { selector: '#sc_trace_mode', key: 'traceMode' },
        { selector: '#sc_prompt_input_log_mode', key: 'promptInputLogMode' },
        { selector: '#sc_prompt_output_log_mode', key: 'promptOutputLogMode' },
        { selector: '#sc_apply_regex_scripts', key: 'applyRegexScripts' },
        { selector: '#sc_strip_chinese_ideographs', key: 'stripChineseIdeographs' },
    ];

    for (const toggle of toggles) {
        bindDocumentSetting({
            eventName: 'change',
            selector: toggle.selector,
            key: toggle.key,
            read: readChecked,
        });
    }
}

/**
 * Bind handlers for memory mode and custom injection placement.
 * @returns {void}
 */
function bindMemoryModeHandlers() {
    $(document).on('change', 'input[name="sc_memory_mode"]', function () {
        const mode = String($(this).val());
        const s = getSettings();
        if (s.memoryMode === mode) {
            return;
        }

        s.memoryMode = mode;
        s.verbatimTokenBudget = mode === MEMORY_MODES.CACHE ? 32000 : 16000;
        saveSettings();
        updateInjection();
        updateUI();
    });

    /** @type {Array<{ eventName: string, selector: string, key: string, read: (source: object) => unknown }>} */
    const customPlacementBindings = [
        {
            eventName: 'change',
            selector: '#sc_custom_memory_position',
            key: 'customMemoryPosition',
            read: readString,
        },
        {
            eventName: 'change',
            selector: '#sc_custom_memory_role',
            key: 'customMemoryRole',
            read: readString,
        },
        {
            eventName: 'input change',
            selector: '#sc_custom_memory_depth',
            key: 'customMemoryDepth',
            read: ($element) => clampNumberInput($element.val(), 0, 10000),
        },
    ];

    for (const binding of customPlacementBindings) {
        bindDocumentSetting({
            ...binding,
            afterSave: refreshCustomMemoryPlacement,
        });
    }
}

function refreshCustomMemoryPlacement() {
    updateInjection();
    updateUI();
}

function requestAutoSummaryRefresh(reason) {
    void maybeSummarizeTurns()
        .catch((e) => {
            warn(`Auto summarization request after ${reason} failed:`, e);
        })
        .finally(updateUI);
}

function clampNumberInput(value, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
        return min;
    }
    return Math.min(max, Math.max(min, parsed));
}

/**
 * Bind handlers for strip patterns and response length inputs.
 * @returns {void}
 */
function bindInputHelpers() {
    bindDocumentSetting({
        eventName: 'input',
        selector: '#sc_summarizer_response_length',
        key: 'summarizerResponseLength',
        read: readIntegerOrZero,
    });

    bindDocumentSetting({
        eventName: 'change',
        selector: '#sc_strip_patterns',
        key: 'stripPatterns',
        read: readStripPatterns,
    });
}

function readStripPatterns($element) {
    return readString($element)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Bind handlers for slider inputs.
 * @returns {void}
 */
function bindSliderHandlers() {
    bindSliderSettingPairs(SETTING_SLIDER_SELECTOR, {
        beforeSave: (_settings, _value, _source, key) => enforceRetentionConstraints(key),
        afterSave: (settings) => {
            updateInjection();
            syncPayloadSchematic(settings);
        },
    });

    bindInputHelpers();
}

function enforceRetentionConstraints(changedKey) {
    const s = getSettings();
    if (changedKey === 'maxSummaryTurns' && s.maxSummaryTurns < s.minSummaryTurns) {
        s.minSummaryTurns = s.maxSummaryTurns;
    }
    if (s.maxSummaryTurns < s.minSummaryTurns) {
        s.maxSummaryTurns = s.minSummaryTurns;
    }
}

/**
 * Bind handlers for non-prompt textarea settings.
 * @returns {void}
 */
function bindTextareaHandlers() {
    /** @type {Array<{ id: string, key: 'injectionTemplate' }>} */
    const textareas = [{ id: '#sc_injection_template', key: 'injectionTemplate' }];

    for (const ta of textareas) {
        bindDocumentSetting({
            eventName: 'change',
            selector: ta.id,
            key: ta.key,
            read: readString,
        });
    }
}

/**
 * Abort a manual summarization run from its progress toast.
 * @param {AbortController} controller
 * @returns {void}
 */
function cancelManualRun(controller) {
    controller.abort();
    abortSummarization();
}

/**
 * Force the catch-up pass to summarize turns beyond the dynamic verbatim window.
 * @returns {Promise<void>}
 */
async function onForceSummarize() {
    const s = getSettings();
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return;
    }
    if (getIsSummarizing()) {
        toastr.warning('Already summarizing. Please wait.');
        return;
    }
    showManualCacheWarning(s);
    $(this)
        .prop('disabled', true)
        .html('<i class="fa-solid fa-spinner fa-spin"></i><span>Working...</span>');
    try {
        const plan = await getLayer0OverflowPlan(getChat(), getChatStore(), s);

        if (plan.reason === 'none') {
            toastr.info(
                'Nothing to summarize - current chat is within the verbatim window.',
                'Summaryception',
            );
            return;
        }

        const overflow = Math.max(plan.eligibleTurns.length, plan.overflowCount);
        toastr.info(`${overflow} turns ready to process. Starting...`, 'Summaryception', {
            timeOut: 2000,
        });

        const controller = new AbortController();
        let progressToast = null;
        const outcome = await runManualWithProgress(
            () =>
                runCatchup(plan.visibleTurns, overflow, {
                    signal: controller.signal,
                    onStart: (progress) => {
                        progressToast = createManualProgressToast({
                            ...progress,
                            onCancel: () => cancelManualRun(controller),
                        });
                    },
                    onProgress: (progress) => updateManualProgressToast(progressToast, progress),
                }),
            () => clearManualProgressToast(progressToast),
        );
        showCatchupOutcome(outcome);
        updateInjection();
        reloadAfterManualRun(outcome);
    } finally {
        $(this)
            .prop('disabled', false)
            .html('<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>');
        updateUI();
    }
}

/**
 * Run Slop Breaker after validating the current chat tail.
 * @returns {Promise<void>}
 */
async function onSlopBreaker() {
    const s = getSettings();
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return;
    }
    if (getIsSummarizing()) {
        toastr.warning('Already summarizing. Please wait.');
        return;
    }
    showManualCacheWarning(s);

    const plan = await getSlopBreakerPlan(getChat(), getChatStore(), s);
    if (plan.reason !== 'ready') {
        showSlopBreakerNoop();
        return;
    }
    if (!(await confirmSlopBreaker())) {
        return;
    }

    $(this)
        .prop('disabled', true)
        .html('<i class="fa-solid fa-spinner fa-spin"></i><span>Working...</span>');
    try {
        const controller = new AbortController();
        let progressToast = null;
        const outcome = await runManualWithProgress(
            () =>
                runSlopBreaker({
                    signal: controller.signal,
                    onStart: (progress) => {
                        progressToast = createManualProgressToast({
                            ...progress,
                            onCancel: () => cancelManualRun(controller),
                        });
                    },
                    onProgress: (progress) => updateManualProgressToast(progressToast, progress),
                }),
            () => clearManualProgressToast(progressToast),
        );
        showSlopBreakerOutcome(outcome);
        updateInjection();
        reloadAfterManualRun(outcome);
    } finally {
        $(this)
            .prop('disabled', false)
            .html('<i class="fa-solid fa-broom"></i><span>Slop Breaker</span>');
        updateUI();
    }
}

function showManualCacheWarning(settings) {
    if (settings.memoryMode !== MEMORY_MODES.CACHE) {
        return;
    }
    toastr.info(
        'Manual summarization updates memory immediately and may reset cache savings for the next request.',
        'Summaryception',
        { timeOut: 5000 },
    );
}

/**
 * Clear progress UI even if a manual run throws.
 * @param {() => Promise<object>} run
 * @param {() => void} cleanup
 * @returns {Promise<object>}
 */
async function runManualWithProgress(run, cleanup) {
    try {
        return await run();
    } finally {
        cleanup();
    }
}

/**
 * Reload the page after successful manual context changes.
 * @param {{ shouldReload?: boolean } | undefined} outcome
 * @returns {void}
 */
function reloadAfterManualRun(outcome) {
    if (!outcome?.shouldReload) {
        return;
    }
    reloadPage();
}

function reloadPage() {
    const reload = globalThis.location?.reload;
    if (typeof reload === 'function') {
        reload.call(globalThis.location);
    }
}

/**
 * Import summary memory from a JSON file.
 *
 * Vanilla document.createElement is used for the ephemeral <input type="file">
 * because it never enters the live DOM - we read its files and discard it.
 * @returns {void}
 */
function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const file = target.files?.[0];
        if (!file) {
            return;
        }
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.layers || !Array.isArray(data.layers)) {
                toastr.error('Invalid file format.');
                return;
            }

            const store = getChatStore();

            await unghostAllMessages();

            store.layers = data.layers;
            store.summarizedUpTo = data.summarizedUpTo ?? -1;
            store.ghostedIndices = data.ghostedIndices || [];
            bumpSummaryStoreMutationEpoch(store);

            if (store.summarizedUpTo >= 0) {
                await ghostMessagesUpTo(store.summarizedUpTo, { showProgress: true });
            }

            await persistAndRefresh({ ui: true });
            toastr.success(
                `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                'Summaryception',
                { timeOut: 4000 },
            );
        } catch (err) {
            error(err);
            toastr.error('Import failed - check console.');
        }
    };
    input.click();
}

/**
 * Reset advanced settings to defaults.
 * @returns {void}
 */
function onResetDefaults() {
    if (
        !confirm(
            'Reset all Advanced Settings to defaults?\n\n' +
                'This will reset sliders, stock prompts, injection template, and strip patterns.\n' +
                'It will NOT clear your summary memory, connection settings, selected memory mode, or custom prompt fields.',
        )
    ) {
        return;
    }

    const s = getSettings();
    const preservedMemoryMode = s.memoryMode;
    const preservedCustomMemoryPosition = s.customMemoryPosition;
    const preservedCustomMemoryRole = s.customMemoryRole;
    const preservedCustomMemoryDepth = s.customMemoryDepth;

    // Reset sliders
    s.memoryMode = preservedMemoryMode;
    s.customMemoryPosition = preservedCustomMemoryPosition;
    s.customMemoryRole = preservedCustomMemoryRole;
    s.customMemoryDepth = preservedCustomMemoryDepth;
    s.minSummaryTurns = defaultSettings.minSummaryTurns;
    s.maxSummaryTurns = defaultSettings.maxSummaryTurns;
    s.minSummaryBudget = defaultSettings.minSummaryBudget;
    s.verbatimTokenBudget =
        preservedMemoryMode === MEMORY_MODES.CACHE ? 32000 : defaultSettings.verbatimTokenBudget;
    s.memoryTokenBudget = defaultSettings.memoryTokenBudget;
    s.layer0SummaryTokenTarget = defaultSettings.layer0SummaryTokenTarget;
    s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
    s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;

    resetPromptFields(s);
    s.injectionTemplate = defaultSettings.injectionTemplate;
    s.stripPatterns = [...defaultSettings.stripPatterns];
    s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

    // Reset debug
    s.debugMode = true;
    s.traceMode = defaultSettings.traceMode;
    s.promptInputLogMode = defaultSettings.promptInputLogMode;
    s.promptOutputLogMode = defaultSettings.promptOutputLogMode;
    s.applyRegexScripts = defaultSettings.applyRegexScripts;
    s.stripChineseIdeographs = defaultSettings.stripChineseIdeographs;

    saveSettings();
    updateInjection();
    updateUI();

    toastr.success(
        'Advanced settings reset to defaults. Memory mode, connection settings, and summary memory were preserved.',
        'Summaryception',
        { timeOut: 4000 },
    );
}

function resetPromptFields(settings) {
    for (const field of PROMPT_FIELDS) {
        if (settings[field.presetKey] === 'custom') {
            continue;
        }
        settings[field.presetKey] = field.defaultPreset;
        settings[field.settingKey] =
            field.presets[field.defaultPreset] || defaultSettings[field.settingKey];
    }
}

/**
 * Bind action button click handlers (repair, clear, force, stop, export, import, reset).
 * @returns {void}
 */
function bindClickHandlers() {
    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) {
            return;
        }

        try {
            await clearSummaryceptionMemory({ updateUi: true });
            toastr.success(
                'Memory cleared & messages unghosted. Reloading chat context.',
                'Summaryception',
                { timeOut: 2000 },
            );
            reloadPage();
        } catch (e) {
            error('Clear memory failed:', e);
            toastr.error(
                'Clear failed. Open F12 and update Summaryception if this repeats.',
                'Summaryception',
                { timeOut: 8000 },
            );
        }
    });

    $(document).on('click', '#sc_force_summarize', onForceSummarize);
    $(document).on('click', '#sc_slop_breaker', onSlopBreaker);

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!getIsSummarizing() && !hasActiveAbortController()) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', {
            timeOut: 4000,
        });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), 2000);
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $(document).on('click', '#sc_import', triggerImport);

    $(document).on('click', '#sc_reset_defaults', onResetDefaults);
}

/**
 * Bind preset and edit handlers for prompt fields.
 * @returns {void}
 */
function bindPromptProfileHandlers() {
    for (const field of PROMPT_FIELDS) {
        bindPromptPresetSelect(field);
        bindPromptTextarea(field);
    }
}

function bindPromptPresetSelect(field) {
    $(document).on('change', field.presetSelect, function () {
        const selected = String($(this).val());
        if (!Object.hasOwn(field.presets, selected)) {
            $(field.presetSelect).val(field.defaultPreset);
            return;
        }

        const s = getSettings();

        s[field.presetKey] = selected;

        if (selected !== 'custom') {
            const presetText = field.presets[selected] || field.presets[field.defaultPreset];
            $(field.textarea).val(presetText);
            s[field.settingKey] = presetText;
        }

        saveSettings();
    });
}

function bindPromptTextarea(field) {
    for (const eventName of ['input', 'change']) {
        $(document).on(eventName, field.textarea, function () {
            const s = getSettings();
            const currentText = $(this).val();
            s[field.settingKey] = currentText;

            switchPromptFieldToCustom(field, s);
            saveSettings();
        });
    }
}

function switchPromptFieldToCustom(field, settings) {
    if (settings[field.presetKey] === 'custom') {
        return;
    }

    settings[field.presetKey] = 'custom';
    $(field.presetSelect).val('custom');
}
