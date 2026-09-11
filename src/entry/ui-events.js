import {
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    TOAST_TITLE,
    MASK_USER_ROLE_MODES,
    applyMemoryModePreset,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    RECALL_REPEAT_INJECTION_TEMPLATE,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    UI_MODES,
    defaultSettings,
} from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { clampInteger } from '../foundation/numeric.js';
import { rangesFromSortedIndices, resolveScIdsToIndices } from '../foundation/message-identity.js';
import { error, warn } from '../foundation/logger.js';
import {
    bumpSummaryStoreMutationEpoch,
    deriveAdvancedEngineTuning,
    enforceRetentionInvariants,
    getEffectiveSettings,
    getSettings,
    isValidSnippet,
    saveSettings,
    getChatStore,
} from '../foundation/state.js';
import { ghostMessagesInRange, unghostAllMessages } from '../core/ghosting.js';
import {
    abortSummarization,
    getIsSummarizing,
    hasActiveAbortController,
    maybeSummarizeTurns,
    runCatchup,
    runSlopBreaker,
} from '../core/summarizer.js';
import {
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from '../core/summarization-routes.js';
import { updateInjection } from '../features/injection.js';
import { persistAndRefresh } from '../features/persist.js';
import { clearSummaryceptionMemory } from '../features/memory.js';
import { updateUI, syncLLMContextPreview } from './ui.js';
import {
    clearManualProgressToast,
    confirmSlopBreaker,
    createManualProgressToast,
    showCatchupOutcome,
    showBusySummaryToast,
    showSlopBreakerNoop,
    showSlopBreakerOutcome,
    updateManualProgressToast,
} from './ui-dialogs.js';
import {
    SETTING_SLIDER_SELECTOR,
    bindDataSettingElements,
    bindDocumentSetting,
    bindSliderSettingPairs,
    readChecked,
    readString,
    syncRoleMaskModeControl,
} from './ui-bind.js';

// UI-specific metadata for each shared prompt pair, keyed by presetKey. The
// (presetKey, settingKey) pairs themselves live in PROMPT_SETTING_KEYS.
const PROMPT_FIELD_UI = {
    summarizerSystemPromptPreset: {
        presetSelect: '#sc_summarizer_system_prompt_preset',
        textarea: '#sc_summarizer_system_prompt',
        presets: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    },
    promptPreset: {
        presetSelect: '#sc_prompt_preset',
        textarea: '#sc_summarizer_user_prompt',
        presets: PROMPT_PRESETS,
    },
    summarizerRepairPromptPreset: {
        presetSelect: '#sc_summarizer_repair_prompt_preset',
        textarea: '#sc_summarizer_repair_prompt',
        presets: SUMMARIZER_REPAIR_PROMPT_PRESETS,
    },
    promotionSystemPromptPreset: {
        presetSelect: '#sc_promotion_system_prompt_preset',
        textarea: '#sc_promotion_system_prompt',
        presets: PROMOTION_SYSTEM_PROMPT_PRESETS,
    },
    promotionPromptPreset: {
        presetSelect: '#sc_promotion_prompt_preset',
        textarea: '#sc_promotion_user_prompt',
        presets: PROMOTION_PROMPT_PRESETS,
    },
    promotionRepairPromptPreset: {
        presetSelect: '#sc_promotion_repair_prompt_preset',
        textarea: '#sc_promotion_repair_prompt',
        presets: PROMOTION_REPAIR_PROMPT_PRESETS,
    },
};

const PROMPT_FIELDS = PROMPT_SETTING_KEYS.map(({ presetKey, settingKey }) => ({
    presetKey,
    settingKey,
    ...PROMPT_FIELD_UI[presetKey],
    defaultPreset: defaultSettings[presetKey],
}));

/**
 * Save settings, then update injection and the UI.
 * @returns {void}
 */
export function saveAndRefreshUi() {
    saveSettings();
    updateInjection();
    updateUI();
}

// Event bindings

/**
 * Bind document event handlers for the Summaryception UI.
 * @returns {void}
 */
export function bindUIEvents() {
    bindModeHandlers();
    bindToggleHandlers();
    bindSliderHandlers();
    bindTextareaHandlers();
    bindClickHandlers();
    bindPromptProfileHandlers();
}

function bindModeHandlers() {
    $(document).on('change', 'input[name="sc_ui_mode"]', function () {
        const mode = String($(this).val());
        if (!(/** @type {string[]} */ (Object.values(UI_MODES)).includes(mode))) {
            return;
        }

        const s = getSettings();
        if (s.uiMode === mode) {
            return;
        }

        s.uiMode = mode;
        s.enabled = mode !== UI_MODES.OFF;
        // Remember the complexity panel so it stays visible when the extension
        // is turned off; selecting Easy/Advanced updates it, Off leaves it.
        if (mode === UI_MODES.EASY || mode === UI_MODES.ADVANCED) {
            s.configMode = mode;
        }
        saveAndRefreshUi();
        if (s.enabled) {
            requestAutoSummaryRefresh('mode changed');
        }
    });
}

/**
 * Bind change handlers for toggle-style settings.
 * @returns {void}
 */
function bindToggleHandlers() {
    $(document).on('change', '#sc_enabled', function () {
        const s = getSettings();
        s.enabled = $(this).prop('checked');
        // Preserve the chosen complexity panel; only flip on/off, not Easy↔Advanced.
        s.uiMode = s.enabled ? s.configMode || UI_MODES.EASY : UI_MODES.OFF;
        saveAndRefreshUi();
        if (s.enabled) {
            requestAutoSummaryRefresh('enabled');
        }
    });

    // Plain on/off checkboxes: the key lives in data-sc-setting and the
    // element kind supplies the boolean reader. Special toggles stay below.
    const plainToggles = [
        '#sc_debug_mode',
        '#sc_trace_mode',
        '#sc_prompt_input_log_mode',
        '#sc_prompt_output_log_mode',
        '#sc_apply_regex_scripts',
        '#sc_hide_non_text_messages',
        '#sc_strip_chinese_ideographs',
        '#sc_state_cat_bonds',
        '#sc_state_cat_chekhov',
        '#sc_state_cat_gm_notes',
        '#sc_state_cat_inventory',
        '#sc_state_cat_location',
    ].join(', ');
    bindDataSettingElements(plainToggles, { eventName: 'change' });

    bindDocumentSetting({
        eventName: 'change',
        selector: '#sc_inject_current_state',
        key: 'injectCurrentState',
        read: readChecked,
        afterSave: refreshInjectionPreview,
    });
    bindDocumentSetting({
        eventName: 'change',
        selector: '#sc_mask_user_role_as_assistant',
        key: 'maskUserRoleAsAssistant',
        read: readChecked,
        afterSave: (_settings, value) => syncRoleMaskModeControl(Boolean(value)),
    });

    bindDocumentSetting({
        eventName: 'change',
        selector: '#sc_mask_user_role_mode',
        key: 'maskUserRoleMode',
        read: readString,
        beforeSave: (settings, _value, $source) => {
            const mode = String(_value);
            if (!(/** @type {string[]} */ (Object.values(MASK_USER_ROLE_MODES)).includes(mode))) {
                settings.maskUserRoleMode = defaultSettings.maskUserRoleMode;
                $source.val(defaultSettings.maskUserRoleMode);
            }
        },
    });
    $(document).on(
        'change',
        'input[name="sc_easy_memory_mode"], input[name="sc_memory_mode"]',
        function () {
            const settings = getSettings();
            if (!applyMemoryModePreset(settings, String($(this).val()))) {
                return;
            }
            saveAndRefreshUi();
        },
    );
    bindCustomPlacementHandlers();
}

function bindCustomPlacementHandlers() {
    // Position and role are plain selects: key and fixed option values live in
    // settings.html, so the engine reads and writes them identically.
    bindDataSettingElements('#sc_custom_memory_position, #sc_custom_memory_role', {
        eventName: 'change',
        afterSave: refreshEffectiveSettings,
    });
    // Depth clamps to 0..10000 and saves on both input and change, so it stays
    // hand-bound: the engine has no clamped reader or dual-event binding.
    bindDocumentSetting({
        eventName: 'input change',
        selector: '#sc_custom_memory_depth',
        key: 'customMemoryDepth',
        read: ($element) => clampInteger($element.val(), 0, 10000),
        afterSave: refreshEffectiveSettings,
    });
}

/**
 *
 */
export function refreshEffectiveSettings() {
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

/**
 * Re-render the injection preview after a saved setting changes it.
 * @returns {void}
 */
function refreshInjectionPreview() {
    updateInjection();
    syncLLMContextPreview(getEffectiveSettings());
}

/**
 * Bind handlers for slider inputs.
 * @returns {void}
 */
function bindSliderHandlers() {
    bindSliderSettingPairs(SETTING_SLIDER_SELECTOR, {
        beforeSave: (_settings, _value, _source, key) => enforceRetentionConstraints(key),
        afterSave: refreshInjectionPreview,
    });
}

/**
 * Re-sync slider partner settings in the same tick: lowering Model context
 * retunes the engine, lowering Max turns pulls Min turns down with it, and
 * the shared invariants keep the retention pairs ordered and capped.
 * @param {string} changedKey - data-sc-setting key of the slider that changed
 * @returns {void}
 */
function enforceRetentionConstraints(changedKey) {
    const s = getSettings();
    if (changedKey === 'advancedModelContext') {
        deriveAdvancedEngineTuning(s);
    }
    if (changedKey === 'maxSummaryTurns' && s.maxSummaryTurns < s.minSummaryTurns) {
        s.minSummaryTurns = s.maxSummaryTurns;
    }
    enforceRetentionInvariants(s);
}

/**
 * Bind handlers for non-prompt textarea settings.
 * @returns {void}
 */
function bindTextareaHandlers() {
    // Strip patterns: key and "lines" type are declared in settings.html.
    bindDataSettingElements('#sc_strip_patterns', { eventName: 'change' });
    bindDocumentSetting({
        eventName: 'change',
        selector: '#sc_injection_template',
        key: 'injectionTemplate',
        read: readString,
    });
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
 * Stop the in-flight summarizer and latch autoPaused so automatic cycles do
 * not resume on their own while the user is still changing settings.
 * @returns {void}
 */
function onStopSummarize() {
    if (!getIsSummarizing() && !hasActiveAbortController()) {
        if (getSettings().autoPaused) {
            toastr.info('Already paused.', TOAST_TITLE);
        } else {
            toastr.info('Nothing is running.', TOAST_TITLE);
        }
        return;
    }
    abortSummarization();
    const s = getSettings();
    s.autoPaused = true;
    saveSettings();
    toastr.warning('Summarization paused. Progress saved. Press Resume to continue.', TOAST_TITLE, {
        timeOut: 5000,
    });
    $(this).prop('disabled', true);
    setTimeout(() => $(this).prop('disabled', false), 2000);
    updateUI();
}

/**
 * Clear the autoPaused latch and kick a single automatic cycle.
 * @returns {void}
 */
function onResumeSummarize() {
    const s = getSettings();
    if (!s.autoPaused) {
        toastr.info('Not paused.', TOAST_TITLE);
        return;
    }
    s.autoPaused = false;
    saveSettings();
    toastr.success('Resumed. Automatic summarization is active again.', TOAST_TITLE, {
        timeOut: 3000,
    });
    updateUI();
    void maybeSummarizeTurns().catch((e) => warn('Resume-triggered summary failed:', e));
}

/**
 * Force Summarize button click handler.
 * @returns {Promise<void>}
 */
async function onForceSummarize() {
    await executeForceSummarize($(this));
}

const MANUAL_RUN_BUSY_HTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Working...</span>';

/**
 * Shared manual-run driver: busy button, abort/progress wiring, outcome
 * report, injection refresh, reload, and UI update. `run` receives the
 * engine options carrying the abort signal; returning undefined skips the
 * outcome report (nothing ran).
 * @param {object | null} $button jQuery-wrapped trigger button, disabled while running.
 * @param {string} idleHtml Button html restored after the run.
 * @param {{ run: (options: object) => Promise<object | undefined>, report: (outcome: object) => void }} ops
 * @returns {Promise<void>}
 */
async function runManualSummarization($button, idleHtml, { run, report }) {
    const controller = new AbortController();
    let progressToast = null;
    const options = {
        signal: controller.signal,
        onStart: (progress) => {
            progressToast = createManualProgressToast({
                ...progress,
                onCancel: () => cancelManualRun(controller),
            });
        },
        onProgress: (progress) => updateManualProgressToast(progressToast, progress),
    };
    if ($button) {
        $button.prop('disabled', true).html(MANUAL_RUN_BUSY_HTML);
    }
    try {
        const outcome = await run(options);
        if (outcome !== undefined) {
            report(outcome);
            updateInjection();
            reloadAfterManualRun(outcome);
        }
    } finally {
        clearManualProgressToast(progressToast);
        if ($button) {
            $button.prop('disabled', false).html(idleHtml);
        }
        updateUI();
    }
}

/**
 * Shared manual-run guard. Show the toast for the first failing check.
 * @param {object} s Effective settings.
 * @returns {boolean} true when a manual run is allowed.
 */
function guardManualRun(s) {
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return false;
    }
    if (getIsSummarizing()) {
        showBusySummaryToast();
        return false;
    }
    showManualCacheWarning(s);
    return true;
}

/**
 * Run Force Summarize from a panel button or the stale-cache advice toast.
 * @param {object | null} $button jQuery-wrapped trigger button, disabled while running.
 * @returns {Promise<void>}
 */
async function executeForceSummarize($button) {
    const s = getEffectiveSettings();
    if (!guardManualRun(s)) {
        return;
    }
    await runManualSummarization(
        $button,
        '<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>',
        {
            run: async (options) => {
                const plan = await buildForceSummaryRoutePlan(getChat(), getChatStore(), s);

                if (!plan.ready) {
                    toastr.info('Nothing eligible to summarize.', TOAST_TITLE);
                    return;
                }

                const overflow = Math.max(plan.batchTurns.length, plan.overflowCount);
                toastr.info(`${overflow} turns ready to process. Starting...`, TOAST_TITLE, {
                    timeOut: 2000,
                });

                return runCatchup(options);
            },
            report: showCatchupOutcome,
        },
    );
}

/**
 * Run Slop Breaker after validating the current chat tail.
 * @returns {Promise<void>}
 */
async function onSlopBreaker() {
    const s = getEffectiveSettings();
    if (!guardManualRun(s)) {
        return;
    }

    const plan = await buildSlopSummaryRoutePlan(getChat(), getChatStore(), s);
    if (!plan.ready) {
        showSlopBreakerNoop();
        return;
    }
    if (!(await confirmSlopBreaker())) {
        return;
    }

    await runManualSummarization(
        $(this),
        '<i class="fa-solid fa-broom"></i><span>Slop Breaker</span>',
        {
            run: (options) => runSlopBreaker(options),
            report: showSlopBreakerOutcome,
        },
    );
}

function showManualCacheWarning(settings) {
    if (settings.memoryMode !== MEMORY_MODES.PREFIX_CACHE) {
        return;
    }
    toastr.info(
        'Manual summarization updates memory immediately and may reset cache savings for the next request.',
        TOAST_TITLE,
        { timeOut: 5000 },
    );
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
            if (!validateImportPayload(data)) {
                toastr.error('Invalid file format.');
                return;
            }

            const store = getChatStore();
            await unghostAllMessages();
            store.layers = data.layers;
            store.ghostedMessageIds = data.ghostedMessageIds;
            bumpSummaryStoreMutationEpoch(store);
            const indices = resolveScIdsToIndices(getChat(), store.ghostedMessageIds);
            for (const [start, end] of rangesFromSortedIndices(indices)) {
                await ghostMessagesInRange(start, end, { showProgress: true });
            }

            await persistAndRefresh({ ui: true });
            toastr.success(
                `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded.`,
                TOAST_TITLE,
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
 * Check an imported payload's shape before any store mutation: layers must be
 * an array of snippet arrays, each snippet passing the persisted-snippet
 * check, plus a ghosted-ID array. Rejects before getChatStore() touches
 * chat metadata.
 * @param {any} data - Parsed JSON payload
 * @returns {boolean} True when the payload carries valid layers and ghosted IDs
 */
function validateImportPayload(data) {
    return (
        Array.isArray(data?.layers) &&
        Array.isArray(data.ghostedMessageIds) &&
        data.layers.every((layer) => Array.isArray(layer) && layer.every(isValidSnippet))
    );
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
    s.minSummaryTurns = defaultSettings.minSummaryTurns;
    s.maxSummaryTurns = defaultSettings.maxSummaryTurns;
    s.maxL0SourceTokens = defaultSettings.maxL0SourceTokens;
    s.minSummaryBudget = defaultSettings.minSummaryBudget;
    const retentionPreset =
        MEMORY_MODE_PRESETS[preservedMemoryMode] || MEMORY_MODE_PRESETS.balanced;
    s.verbatimTokenBudget = retentionPreset.verbatimTokenBudget;
    s.queuedTokenBudget = retentionPreset.queuedTokenBudget;
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
    s.hideNonTextMessages = defaultSettings.hideNonTextMessages;
    s.stripChineseIdeographs = defaultSettings.stripChineseIdeographs;
    s.injectCurrentState = defaultSettings.injectCurrentState;
    s.maskUserRoleAsAssistant = defaultSettings.maskUserRoleAsAssistant;
    s.maskUserRoleMode = defaultSettings.maskUserRoleMode;

    saveAndRefreshUi();
    toastr.success(
        'Advanced settings reset to defaults. Memory mode, connection settings, and summary memory were preserved.',
        TOAST_TITLE,
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
                TOAST_TITLE,
                { timeOut: 2000 },
            );
            reloadPage();
        } catch (e) {
            error('Clear memory failed:', e);
            toastr.error(
                'Clear failed. Open F12 and update Summaryception if this repeats.',
                TOAST_TITLE,
                { timeOut: 8000 },
            );
        }
    });

    $(document).on('click', '#sc_force_summarize, #sc_easy_force_summarize', onForceSummarize);
    $(document).on('click', '#sc_stale_cache_force', function () {
        const $toast = $(this).closest('.toast');
        if ($toast.length) {
            toastr.clear($toast);
        }
        void executeForceSummarize(null);
    });
    $(document).on('click', '#sc_slop_breaker, #sc_easy_slop_breaker', onSlopBreaker);

    $(document).on('click', '#sc_stop_summarize, #sc_easy_stop_summarize', onStopSummarize);
    $(document).on('click', '#sc_resume_summarize, #sc_easy_resume_summarize', onResumeSummarize);

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
        toastr.success('Memory exported', TOAST_TITLE);
    });

    $(document).on('click', '#sc_import', triggerImport);

    $(document).on('click', '#sc_reset_defaults', onResetDefaults);

    $(document).on('click', '#sc_insert_recall_template', function () {
        if (
            !confirm(
                'Replace the current Injection Wrapper Template with the recall-repeat sample?',
            )
        ) {
            return;
        }
        $('#sc_injection_template').val(RECALL_REPEAT_INJECTION_TEMPLATE).trigger('change');
        toastr.success('Recall-repeat template inserted.', TOAST_TITLE);
    });

    $(document).on('click', '#sc_restore_injection_template', function () {
        if (!confirm('Restore the default Injection Wrapper Template?')) {
            return;
        }
        $('#sc_injection_template').val(defaultSettings.injectionTemplate).trigger('change');
        toastr.success('Default injection template restored.', TOAST_TITLE);
    });
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
    $(document).on('input change', field.textarea, function () {
        const s = getSettings();
        const currentText = $(this).val();
        s[field.settingKey] = currentText;

        switchPromptFieldToCustom(field, s);
        saveSettings();
    });
}

function switchPromptFieldToCustom(field, settings) {
    if (settings[field.presetKey] === 'custom') {
        return;
    }

    settings[field.presetKey] = 'custom';
    $(field.presetSelect).val('custom');
}
