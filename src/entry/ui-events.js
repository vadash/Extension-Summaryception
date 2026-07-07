import {
    MEMORY_MODES,
    PROMOTION_PROMPT_PRESETS,
    PROMPT_PRESETS,
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
    resetCatchupDismissed,
    runCatchup,
    runSlopBreaker,
} from '../core/summarizer.js';
import { getSlopBreakerPlan } from '../core/slop-breaker.js';
import { getLayer0OverflowPlan } from '../core/verbatim-window.js';
import { updateInjection } from '../features/injection.js';
import { persistAndRefresh } from '../features/persist.js';
import { clearSummaryceptionMemory } from '../features/memory.js';
import { updateUI, updateCustomPromptSlots, syncPayloadSchematic } from './ui.js';
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

const PROMPT_PROFILES = {
    layer0: {
        label: 'Layer 0',
        exportName: 'L0_summary',
        presetSelect: '#sc_prompt_preset',
        customManager: '#sc_custom_prompt_manager',
        customSlot: '#sc_custom_prompt_slot',
        customName: '#sc_custom_prompt_name',
        saveButton: '#sc_custom_prompt_save',
        loadButton: '#sc_custom_prompt_load',
        deleteButton: '#sc_custom_prompt_delete_slot',
        exportButton: '#sc_custom_prompt_export',
        importButton: '#sc_custom_prompt_import',
        systemPrompt: '#sc_summarizer_system_prompt',
        userPrompt: '#sc_summarizer_user_prompt',
        presetKey: 'promptPreset',
        savedPromptsKey: 'savedCustomPrompts',
        systemPromptKey: 'summarizerSystemPrompt',
        userPromptKey: 'summarizerUserPrompt',
        presets: PROMPT_PRESETS,
        defaultPreset: defaultSettings.promptPreset,
    },
    promotion: {
        label: 'Layer 1+',
        exportName: 'L1_summary',
        presetSelect: '#sc_promotion_prompt_preset',
        customManager: '#sc_promotion_custom_prompt_manager',
        customSlot: '#sc_promotion_custom_prompt_slot',
        customName: '#sc_promotion_custom_prompt_name',
        saveButton: '#sc_promotion_custom_prompt_save',
        loadButton: '#sc_promotion_custom_prompt_load',
        deleteButton: '#sc_promotion_custom_prompt_delete_slot',
        exportButton: '#sc_promotion_custom_prompt_export',
        importButton: '#sc_promotion_custom_prompt_import',
        systemPrompt: '#sc_promotion_system_prompt',
        userPrompt: '#sc_promotion_user_prompt',
        presetKey: 'promotionPromptPreset',
        savedPromptsKey: 'savedCustomPromotionPrompts',
        systemPromptKey: 'promotionSystemPrompt',
        userPromptKey: 'promotionUserPrompt',
        presets: PROMOTION_PROMPT_PRESETS,
        defaultPreset: defaultSettings.promotionPromptPreset,
    },
};

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
        resetCatchupDismissed();

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

    const plan = getSlopBreakerPlan(getChat(), getChatStore(), s);
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
                'It will NOT clear your summary memory, connection settings, selected memory mode, or custom L0/L1+ prompts.',
        )
    ) {
        return;
    }

    const s = getSettings();
    const preservedMemoryMode = s.memoryMode;
    const preservedCustomMemoryPosition = s.customMemoryPosition;
    const preservedCustomMemoryRole = s.customMemoryRole;
    const preservedCustomMemoryDepth = s.customMemoryDepth;
    const preserveCustomLayer0Prompt = s.promptPreset === 'custom';
    const preserveCustomPromotionPrompt = s.promotionPromptPreset === 'custom';
    const preservedLayer0Prompt = {
        systemPrompt: s.summarizerSystemPrompt,
        userPrompt: s.summarizerUserPrompt,
    };
    const preservedPromotionPrompt = {
        systemPrompt: s.promotionSystemPrompt,
        userPrompt: s.promotionUserPrompt,
    };

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

    // Reset prompts
    s.summarizerSystemPrompt = preserveCustomLayer0Prompt
        ? preservedLayer0Prompt.systemPrompt
        : defaultSettings.summarizerSystemPrompt;
    s.summarizerUserPrompt = preserveCustomLayer0Prompt
        ? preservedLayer0Prompt.userPrompt
        : defaultSettings.summarizerUserPrompt;
    s.promotionSystemPrompt = preserveCustomPromotionPrompt
        ? preservedPromotionPrompt.systemPrompt
        : defaultSettings.promotionSystemPrompt;
    s.promotionUserPrompt = preserveCustomPromotionPrompt
        ? preservedPromotionPrompt.userPrompt
        : defaultSettings.promotionUserPrompt;
    s.promptPreset = preserveCustomLayer0Prompt ? 'custom' : defaultSettings.promptPreset;
    s.promotionPromptPreset = preserveCustomPromotionPrompt
        ? 'custom'
        : defaultSettings.promotionPromptPreset;
    s.injectionTemplate = defaultSettings.injectionTemplate;
    s.stripPatterns = [...defaultSettings.stripPatterns];
    s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

    // Reset debug
    s.debugMode = true;
    s.traceMode = defaultSettings.traceMode;
    s.promptInputLogMode = defaultSettings.promptInputLogMode;
    s.promptOutputLogMode = defaultSettings.promptOutputLogMode;
    s.promptLogMode = defaultSettings.promptLogMode;
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

/**
 * Bind action button click handlers (repair, clear, force, stop, export, import, reset).
 * @returns {void}
 */
function bindClickHandlers() {
    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) {
            return;
        }

        await clearSummaryceptionMemory({ updateUi: true });
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
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
 * Bind preset, custom slot, import/export, and edit handlers for prompt profiles.
 * @returns {void}
 */
function bindPromptProfileHandlers() {
    for (const profile of Object.values(PROMPT_PROFILES)) {
        bindPromptPresetSelect(profile);
        bindPromptTextarea(profile, profile.systemPrompt, profile.systemPromptKey);
        bindPromptTextarea(profile, profile.userPrompt, profile.userPromptKey);
        bindCustomPromptHandlers(profile);
    }
}

function bindPromptPresetSelect(profile) {
    $(document).on('change', profile.presetSelect, function () {
        const selected = String($(this).val());
        if (!Object.hasOwn(profile.presets, selected)) {
            $(profile.presetSelect).val(profile.defaultPreset);
            return;
        }

        const s = getSettings();

        s[profile.presetKey] = selected;

        if (selected === 'custom') {
            $(profile.customManager).show();
        } else {
            const presetText = profile.presets[selected] || profile.presets[profile.defaultPreset];
            $(profile.userPrompt).val(presetText);
            s[profile.userPromptKey] = presetText;
            $(profile.customManager).hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });
}

function bindPromptTextarea(profile, selector, settingKey) {
    for (const eventName of ['input', 'change']) {
        $(document).on(eventName, selector, function () {
            const s = getSettings();
            const currentText = $(this).val();
            s[settingKey] = currentText;

            switchPromptProfileToCustom(profile, s);
            saveSettings();
        });
    }
}

function switchPromptProfileToCustom(profile, settings) {
    if (settings[profile.presetKey] === 'custom') {
        return;
    }

    settings[profile.presetKey] = 'custom';
    $(profile.presetSelect).val('custom');
    $(profile.customManager).show();
    updateCustomPromptSlots();
}

/**
 * Bind handlers for custom prompt save/load/delete/export/import actions.
 * @param {object} profile
 * @returns {void}
 */
function bindCustomPromptHandlers(profile) {
    $(document).on('click', profile.saveButton, function () {
        const name = String($(profile.customName).val()).trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s[profile.savedPromptsKey]) {
            s[profile.savedPromptsKey] = {};
        }

        const promptText = $(profile.userPrompt).val();
        if (!String(promptText).trim()) {
            toastr.warning('Prompt is empty - nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s[profile.savedPromptsKey][name];
        s[profile.savedPromptsKey][name] = promptText;
        saveSettings();

        $(profile.customName).val('');
        updateCustomPromptSlots();

        toastr.success(`Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`, 'Summaryception', {
            timeOut: 2000,
        });
    });

    $(document).on('click', profile.loadButton, function () {
        const name = $(profile.customSlot).val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s[profile.savedPromptsKey]?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $(profile.userPrompt).val(promptText);
        s[profile.userPromptKey] = promptText;
        s[profile.presetKey] = 'custom';
        $(profile.presetSelect).val('custom');
        $(profile.customManager).show();
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: 2000 });
    });

    $(document).on('click', profile.deleteButton, function () {
        const name = $(profile.customSlot).val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) {
            return;
        }

        const s = getSettings();
        if (s[profile.savedPromptsKey]) {
            delete s[profile.savedPromptsKey][name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: 2000 });
    });

    $(document).on('click', profile.exportButton, function () {
        exportCustomPrompt(profile);
    });

    $(document).on('click', profile.importButton, function () {
        triggerCustomPromptImport(profile);
    });
}

function exportCustomPrompt(profile) {
    const promptText = $(profile.userPrompt).val();
    if (!String(promptText).trim()) {
        toastr.warning('Prompt is empty - nothing to export.', 'Summaryception');
        return;
    }

    const blob = new Blob([promptText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `summaryception_${profile.exportName}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Prompt exported.', 'Summaryception', { timeOut: 2000 });
}

/**
 * Import a custom prompt from a user-selected text file.
 *
 * Vanilla document.createElement is used for the ephemeral <input type="file">
 * because it never enters the live DOM - we read its files and discard it.
 * @param {object} profile
 * @returns {void}
 */
function triggerCustomPromptImport(profile) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.text';
    input.onchange = async (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const file = target.files?.[0];
        if (!file) {
            return;
        }
        try {
            const text = await file.text();
            if (!text.trim()) {
                toastr.warning('File is empty.', 'Summaryception');
                return;
            }

            const s = getSettings();
            $(profile.userPrompt).val(text);
            s[profile.userPromptKey] = text;
            s[profile.presetKey] = 'custom';
            $(profile.presetSelect).val('custom');
            $(profile.customManager).show();
            saveSettings();
            updateCustomPromptSlots();

            toastr.success(`Prompt imported from "${file.name}".`, 'Summaryception', {
                timeOut: 3000,
            });
        } catch (err) {
            error(err);
            toastr.error('Import failed - check console.', 'Summaryception');
        }
    };
    input.click();
}
