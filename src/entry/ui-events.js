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
    getEffectiveSettings,
    getSettings,
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
    bindDocumentSetting,
    bindSliderSettingPairs,
    readChecked,
    readString,
    syncRoleMaskModeControl,
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
        saveSettings();
        updateInjection();
        updateUI();

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
        saveSettings();
        updateInjection();
        updateUI();

        if (s.enabled) {
            requestAutoSummaryRefresh('enabled');
        }
    });

    /** @type {Array<{ selector: string, key: string, afterSave?: (settings: ReturnType<typeof getSettings>, value: unknown) => void }>} */
    const toggles = [
        { selector: '#sc_debug_mode', key: 'debugMode' },
        { selector: '#sc_trace_mode', key: 'traceMode' },
        { selector: '#sc_prompt_input_log_mode', key: 'promptInputLogMode' },
        { selector: '#sc_prompt_output_log_mode', key: 'promptOutputLogMode' },
        { selector: '#sc_apply_regex_scripts', key: 'applyRegexScripts' },
        { selector: '#sc_hide_non_text_messages', key: 'hideNonTextMessages' },
        { selector: '#sc_strip_chinese_ideographs', key: 'stripChineseIdeographs' },
        {
            selector: '#sc_inject_current_state',
            key: 'injectCurrentState',
            afterSave: () => {
                updateInjection();
                syncLLMContextPreview(getEffectiveSettings());
            },
        },
        {
            selector: '#sc_mask_user_role_as_assistant',
            key: 'maskUserRoleAsAssistant',
            afterSave: (_settings, value) => syncRoleMaskModeControl(Boolean(value)),
        },
        { selector: '#sc_state_cat_bonds', key: 'stateCatBonds' },
        { selector: '#sc_state_cat_chekhov', key: 'stateCatChekhov' },
        { selector: '#sc_state_cat_gm_notes', key: 'stateCatGmNotes' },
        { selector: '#sc_state_cat_inventory', key: 'stateCatInventory' },
        { selector: '#sc_state_cat_location', key: 'stateCatLocation' },
    ];

    for (const toggle of toggles) {
        bindDocumentSetting({
            eventName: 'change',
            selector: toggle.selector,
            key: toggle.key,
            read: readChecked,
            afterSave: toggle.afterSave,
        });
    }

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
            saveSettings();
            updateInjection();
            updateUI();
        },
    );
    bindCustomPlacementHandlers();
}

function bindCustomPlacementHandlers() {
    /** @type {Array<{ eventName: string, selector: string, key: string, read: (source: object) => unknown }>} */
    const customPlacementBindings = [
        {
            eventName: 'change',
            selector: '#sc_easy_connection_source',
            key: 'connectionSource',
            read: readString,
        },
        {
            eventName: 'change',
            selector: '#sc_easy_connection_profile',
            key: 'connectionProfileId',
            read: readString,
        },
        {
            eventName: 'change',
            selector: '#sc_easy_merge_connection_source',
            key: 'mergeConnectionSource',
            read: readString,
        },
        {
            eventName: 'change',
            selector: '#sc_easy_merge_connection_profile',
            key: 'mergeConnectionProfileId',
            read: readString,
        },
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
            read: ($element) => clampInteger($element.val(), 0, 10000),
        },
    ];

    for (const binding of customPlacementBindings) {
        bindDocumentSetting({
            ...binding,
            afterSave: refreshEffectiveSettings,
        });
    }
}

function refreshEffectiveSettings() {
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
 * Bind the strip patterns input handler.
 * @returns {void}
 */
function bindInputHelpers() {
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
        afterSave: () => {
            updateInjection();
            syncLLMContextPreview(getEffectiveSettings());
        },
    });

    bindInputHelpers();
}

function enforceRetentionConstraints(changedKey) {
    const s = getSettings();
    if (changedKey === 'advancedModelContext') {
        deriveAdvancedEngineTuning(s);
    }
    if (changedKey === 'maxSummaryTurns' && s.maxSummaryTurns < s.minSummaryTurns) {
        s.minSummaryTurns = s.maxSummaryTurns;
    }
    if (s.maxSummaryTurns < s.minSummaryTurns) {
        s.maxSummaryTurns = s.minSummaryTurns;
    }
    const cap = Number(s.maxL0SourceTokens);
    if (s.minSummaryBudget > s.maxL0SourceTokens) {
        s.minSummaryBudget = Number.isFinite(cap) && cap > 0 ? cap : s.maxL0SourceTokens;
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

/**
 * Build the shared abort/progress wiring for a manual summarization run.
 * @returns {{ options: object, clearProgressToast: () => void }}
 */
function makeManualRunOptions() {
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
    return {
        options,
        clearProgressToast: () => clearManualProgressToast(progressToast),
    };
}

/**
 * Run Force Summarize from a panel button or the stale-cache advice toast.
 * @param {object | null} $button jQuery-wrapped trigger button, disabled while running.
 * @returns {Promise<void>}
 */
async function executeForceSummarize($button) {
    const s = getEffectiveSettings();
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return;
    }
    if (getIsSummarizing()) {
        showBusySummaryToast();
        return;
    }
    showManualCacheWarning(s);
    if ($button) {
        $button
            .prop('disabled', true)
            .html('<i class="fa-solid fa-spinner fa-spin"></i><span>Working...</span>');
    }
    try {
        const plan = await buildForceSummaryRoutePlan(getChat(), getChatStore(), s);

        if (!plan.ready) {
            toastr.info('Nothing eligible to summarize.', TOAST_TITLE);
            return;
        }

        const overflow = Math.max(plan.batchTurns.length, plan.overflowCount);
        toastr.info(`${overflow} turns ready to process. Starting...`, TOAST_TITLE, {
            timeOut: 2000,
        });

        const manual = makeManualRunOptions();
        const outcome = await runManualWithProgress(
            () => runCatchup(manual.options),
            manual.clearProgressToast,
        );
        showCatchupOutcome(outcome);
        updateInjection();
        reloadAfterManualRun(outcome);
    } finally {
        if ($button) {
            $button
                .prop('disabled', false)
                .html('<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>');
        }
        updateUI();
    }
}

/**
 * Run Slop Breaker after validating the current chat tail.
 * @returns {Promise<void>}
 */
async function onSlopBreaker() {
    const s = getEffectiveSettings();
    if (!s.enabled) {
        toastr.warning('Enable Summaryception first.');
        return;
    }
    if (getIsSummarizing()) {
        showBusySummaryToast();
        return;
    }
    showManualCacheWarning(s);

    const plan = await buildSlopSummaryRoutePlan(getChat(), getChatStore(), s);
    if (!plan.ready) {
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
        const manual = makeManualRunOptions();
        const outcome = await runManualWithProgress(
            () => runSlopBreaker(manual.options),
            manual.clearProgressToast,
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
            if (
                !Array.isArray(data.ghostedMessageIds) ||
                !data.layers.every(
                    (layer) =>
                        Array.isArray(layer) &&
                        layer.every(
                            (snippet) =>
                                Array.isArray(snippet?.sourceMessageIds) &&
                                snippet.sourceMessageIds.length > 0,
                        ),
                )
            ) {
                toastr.error('Invalid file format.');
                return;
            }

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

    saveSettings();
    updateInjection();
    updateUI();

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
