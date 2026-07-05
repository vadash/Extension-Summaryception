import { MEMORY_MODES, PROMPT_PRESETS, defaultSettings } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { debug, error, warn } from '../foundation/logger.js';
import { getSettings, saveSettings, getChatStore } from '../foundation/state.js';
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
    bindPromptPresetHandlers();
    bindCustomPromptHandlers();
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

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_prompt_log_mode', function () {
        getSettings().promptLogMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_apply_regex_scripts', function () {
        getSettings().applyRegexScripts = $(this).prop('checked');
        saveSettings();
    });
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

    $(document).on('change', '#sc_custom_memory_position', function () {
        getSettings().customMemoryPosition = String($(this).val());
        saveSettings();
        updateInjection();
        updateUI();
    });

    $(document).on('change', '#sc_custom_memory_role', function () {
        getSettings().customMemoryRole = String($(this).val());
        saveSettings();
        updateInjection();
        updateUI();
    });

    $(document).on('input change', '#sc_custom_memory_depth', function () {
        getSettings().customMemoryDepth = clampNumberInput($(this).val(), 0, 10000);
        saveSettings();
        updateInjection();
        updateUI();
    });
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
    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this)
            .val()
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });
}

/**
 * Bind handlers for slider inputs.
 * @returns {void}
 */
function bindSliderHandlers() {
    /** @type {Array<{ id: string, key: 'verbatimTokenBudget' | 'memoryTokenBudget' | 'minSummaryBudget' | 'minSummaryTurns' | 'maxSummaryTurns' | 'snippetsPerLayer' | 'snippetsPerPromotion', display: string }>} */
    const sliders = [
        {
            id: '#sc_verbatim_token_budget',
            key: 'verbatimTokenBudget',
            display: '#sc_verbatim_token_budget_val',
        },
        {
            id: '#sc_memory_token_budget',
            key: 'memoryTokenBudget',
            display: '#sc_memory_token_budget_val',
        },
        {
            id: '#sc_min_summary_budget',
            key: 'minSummaryBudget',
            display: '#sc_min_summary_budget_val',
        },
        {
            id: '#sc_min_summary_turns',
            key: 'minSummaryTurns',
            display: '#sc_min_summary_turns_val',
        },
        {
            id: '#sc_max_summary_turns',
            key: 'maxSummaryTurns',
            display: '#sc_max_summary_turns_val',
        },
        {
            id: '#sc_snippets_per_layer',
            key: 'snippetsPerLayer',
            display: '#sc_snippets_per_layer_val',
        },
        {
            id: '#sc_snippets_per_promotion',
            key: 'snippetsPerPromotion',
            display: '#sc_snippets_per_promotion_val',
        },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = normalizeSliderValue($(this).val(), $(this));
            getSettings()[sl.key] = val;
            enforceRetentionConstraints(sl.key);
            syncSliderDisplays(sliders, sl.key, sl.display);
            saveSettings();
            updateInjection();
        });

        $(document).on('change blur', sl.display, function () {
            const val = normalizeSliderValue($(this).val(), $(sl.id));
            getSettings()[sl.key] = val;
            enforceRetentionConstraints(sl.key);
            syncSliderDisplays(sliders, sl.key, sl.display);
            saveSettings();
            updateInjection();
        });

        $(document).on('focus', sl.display, function () {
            const s = getSettings();
            $(this).val(s[sl.key]);
        });
    }

    bindInputHelpers();
}

function isRetentionSlider(key) {
    return [
        'verbatimTokenBudget',
        'memoryTokenBudget',
        'minSummaryBudget',
        'minSummaryTurns',
        'maxSummaryTurns',
    ].includes(key);
}

/**
 * Normalize a slider value to the paired range input's min, max, and step.
 * @param {unknown} value
 * @param {object} slider jQuery-wrapped range input
 * @returns {number}
 */
function normalizeSliderValue(value, slider) {
    const min = parseSliderAttr(slider, 'min', 0);
    const max = parseSliderAttr(slider, 'max', min);
    const step = parseSliderAttr(slider, 'step', 1);
    const parsed = parseSliderInputValue(value, { min, step });
    const base = Number.isFinite(parsed) ? parsed : min;
    const clamped = Math.min(max, Math.max(min, base));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Math.round(Math.min(max, Math.max(min, snapped)));
}

function parseSliderInputValue(value, { min, step }) {
    const raw = String(value).trim().toLowerCase();
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
        return Number.NaN;
    }
    if (raw.endsWith('k')) {
        return parsed * 1000;
    }
    if (step >= 1000 && parsed > 0 && parsed < min) {
        return parsed * 1000;
    }
    return parsed;
}

function parseSliderAttr(slider, attr, fallback) {
    const parsed = Number.parseFloat(String(slider.attr(attr)));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function syncSliderDisplays(sliders, changedKey, display) {
    if (isRetentionSlider(changedKey)) {
        syncRetentionSliderDisplays();
        return;
    }

    const s = getSettings();
    const binding = sliders.find((sl) => sl.display === display);
    if (!binding) {
        return;
    }
    $(binding.id).val(s[binding.key]);
    $(binding.display).val(formatSliderChipValue(s[binding.key], $(binding.id)));
    syncPayloadSchematic(s);
}

function syncRetentionSliderDisplays() {
    const s = getSettings();
    $('#sc_verbatim_token_budget').val(s.verbatimTokenBudget);
    $('#sc_verbatim_token_budget_val').val(
        formatSliderChipValue(s.verbatimTokenBudget, $('#sc_verbatim_token_budget')),
    );
    $('#sc_memory_token_budget').val(s.memoryTokenBudget);
    $('#sc_memory_token_budget_val').val(
        formatSliderChipValue(s.memoryTokenBudget, $('#sc_memory_token_budget')),
    );
    $('#sc_min_summary_budget').val(s.minSummaryBudget);
    $('#sc_min_summary_budget_val').val(
        formatSliderChipValue(s.minSummaryBudget, $('#sc_min_summary_budget')),
    );
    $('#sc_min_summary_turns').val(s.minSummaryTurns);
    $('#sc_min_summary_turns_val').val(
        formatSliderChipValue(s.minSummaryTurns, $('#sc_min_summary_turns')),
    );
    $('#sc_max_summary_turns').val(s.maxSummaryTurns);
    $('#sc_max_summary_turns_val').val(
        formatSliderChipValue(s.maxSummaryTurns, $('#sc_max_summary_turns')),
    );
    syncPayloadSchematic(s);
}

function formatSliderChipValue(value, slider) {
    const step = parseSliderAttr(slider, 'step', 1);
    if (step >= 1000 && value % 1000 === 0) {
        return `${value / 1000}k`;
    }
    return String(value);
}

/**
 * Bind handlers for non-prompt textarea settings.
 * @returns {void}
 */
function bindTextareaHandlers() {
    /** @type {Array<{ id: string, key: 'injectionTemplate' | 'summarizerSystemPrompt' | 'promotionSystemPrompt' | 'promotionUserPrompt' }>} */
    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
        { id: '#sc_promotion_system_prompt', key: 'promotionSystemPrompt' },
        { id: '#sc_promotion_user_prompt', key: 'promotionUserPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
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
                'This will reset sliders, prompts, injection template, and strip patterns.\n' +
                'It will NOT clear your summary memory or connection settings.',
        )
    ) {
        return;
    }

    const s = getSettings();

    // Reset sliders
    s.memoryMode = defaultSettings.memoryMode;
    s.customMemoryPosition = defaultSettings.customMemoryPosition;
    s.customMemoryRole = defaultSettings.customMemoryRole;
    s.customMemoryDepth = defaultSettings.customMemoryDepth;
    s.minSummaryTurns = defaultSettings.minSummaryTurns;
    s.maxSummaryTurns = defaultSettings.maxSummaryTurns;
    s.minSummaryBudget = defaultSettings.minSummaryBudget;
    s.verbatimTokenBudget = defaultSettings.verbatimTokenBudget;
    s.memoryTokenBudget = defaultSettings.memoryTokenBudget;
    s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
    s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;

    // Reset prompts
    s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
    s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
    s.promotionSystemPrompt = defaultSettings.promotionSystemPrompt;
    s.promotionUserPrompt = defaultSettings.promotionUserPrompt;
    s.promptPreset = defaultSettings.promptPreset;
    s.injectionTemplate = defaultSettings.injectionTemplate;
    s.stripPatterns = [...defaultSettings.stripPatterns];
    s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

    // Reset debug
    s.debugMode = true;
    s.traceMode = defaultSettings.traceMode;
    s.promptLogMode = defaultSettings.promptLogMode;
    s.applyRegexScripts = defaultSettings.applyRegexScripts;

    saveSettings();
    updateInjection();
    updateUI();

    toastr.success(
        'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
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
 * Bind handlers for the prompt preset dropdown and its auto-switch-to-custom behavior.
 * @returns {void}
 */
function bindPromptPresetHandlers() {
    // Prompt Preset dropdown
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            debug('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                debug('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });
}

/**
 * Bind handlers for custom prompt save/load/delete/export/import actions.
 * @returns {void}
 */
function bindCustomPromptHandlers() {
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) {
            s.savedCustomPrompts = {};
        }

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty - nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(`Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`, 'Summaryception', {
            timeOut: 2000,
        });
    });

    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: 2000 });
    });

    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) {
            return;
        }

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: 2000 });
    });

    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty - nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: 2000 });
    });

    $(document).on('click', '#sc_custom_prompt_import', triggerCustomPromptImport);
}

/**
 * Import a custom prompt from a user-selected text file.
 *
 * Vanilla document.createElement is used for the ephemeral <input type="file">
 * because it never enters the live DOM - we read its files and discard it.
 * @returns {void}
 */
function triggerCustomPromptImport() {
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
            $('#sc_summarizer_user_prompt').val(text);
            s.summarizerUserPrompt = text;
            s.lastCustomPrompt = text;
            s.promptPreset = 'custom';
            $('#sc_prompt_preset').val('custom');
            $('#sc_custom_prompt_manager').show();
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
