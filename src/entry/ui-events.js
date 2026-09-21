import {
    TOAST_TITLE,
    MASK_USER_ROLE_MODES,
    applyMemoryModePreset,
    RECALL_REPEAT_INJECTION_TEMPLATE,
    UI_MODES,
    defaultSettings,
} from '../foundation/constants.js';
import { error, warn } from '../foundation/logger.js';
import { clampInteger } from '../foundation/numeric.js';
import { selectOff, setComplexity, setEnabled } from '../foundation/operation-mode.js';
import { refreshFull, refreshPreview } from '../foundation/refresh.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getSettings, resetSettingsToDefaults, saveSettings } from '../foundation/settings.js';
import {
    deriveAdvancedEngineTuning,
    enforceRetentionInvariants,
} from '../foundation/settings-normalizer.js';
import { requestSummarization } from '../core/summarizer-queue.js';
import { clearSummaryceptionMemory, importSummaryceptionMemory } from '../features/memory.js';
import { updateUI } from './ui.js';
import {
    SETTING_SLIDER_SELECTOR,
    bindDataSettingElements,
    bindDocumentSetting,
    bindSliderSettingPairs,
    readChecked,
    readString,
    syncRoleMaskModeControl,
} from './ui-bind.js';
import { bindManualRunControls, reloadPage } from './ui-manual-run.js';
import { bindPromptProfiles } from './ui-prompts.js';

/**
 * @returns {void}
 */
function saveAndRefreshUi() {
    saveSettings();
    refreshFull();
}

// Event bindings

/**
 * Bind document event handlers for the Summaryception UI.
 * @param {import('../core/notify.js').NotifyAdapter} notify - Toastr-backed adapter distributed to core calls.
 * @param {import('../core/summarizer-engine.js').ManualRunnerDeps} manualRunnerDeps - Engine deps for manual runs.
 * @param {import('../core/summarizer-engine.js').PauseLatchDeps} pauseLatchDeps - Engine deps for the pause latch.
 * @returns {void}
 */
export function bindUIEvents(notify, manualRunnerDeps, pauseLatchDeps) {
    bindModeHandlers();
    bindToggleHandlers();
    bindSliderHandlers();
    bindTextareaHandlers();
    bindClickHandlers(notify);
    bindManualRunControls({ notify, manualRunnerDeps, pauseLatchDeps });
    bindPromptProfiles();
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

        if (mode === UI_MODES.OFF) {
            selectOff(s);
        } else {
            setComplexity(s, mode);
        }
        saveAndRefreshUi();
        if (s.enabled) {
            requestAutoSummaryRefresh('mode changed');
        }
    });
}

/**
 * @returns {void}
 */
function bindToggleHandlers() {
    $(document).on('change', '#sc_enabled', function () {
        const s = getSettings();
        setEnabled(s, $(this).prop('checked'));
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
        '#sc_continuity_state_log_mode',
        '#sc_continuity_state_log_full_mode',
        '#sc_apply_regex_scripts',
        '#sc_hide_non_text_messages',
        '#sc_strip_chinese_ideographs',
        '#sc_continuity_enabled',
    ].join(', ');
    bindDataSettingElements(plainToggles, { eventName: 'change' });

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
        afterSave: refreshFull,
    });
    // Depth clamps to 0..10000 and saves on both input and change, so it stays
    // hand-bound: the engine has no clamped reader or dual-event binding.
    bindDocumentSetting({
        eventName: 'input change',
        selector: '#sc_custom_memory_depth',
        key: 'customMemoryDepth',
        read: ($element) => clampInteger($element.val(), 0, 10000),
        afterSave: refreshFull,
    });
}

function requestAutoSummaryRefresh(reason) {
    void requestSummarization()
        .catch((e) => {
            warn(`Auto summarization request after ${reason} failed:`, e);
        })
        .finally(updateUI);
}

/**
 * @returns {void}
 */
function bindSliderHandlers() {
    bindSliderSettingPairs(SETTING_SLIDER_SELECTOR, {
        beforeSave: (_settings, _value, _source, key) => enforceRetentionConstraints(key),
        afterSave: refreshPreview,
        afterSavePartner: refreshFull,
    });
}

/**
 * Re-sync slider partner settings in the same tick. Lowering Model context
 * retunes the engine. Lowering Max turns pulls Min turns down with it. The
 * shared invariants keep the retention pairs ordered and capped.
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
 * Import summary memory from a JSON file.
 *
 * The ephemeral <input type="file"> never enters the live DOM, so vanilla
 * document.createElement suffices. We read its files and discard it.
 * @param {import('../core/notify.js').NotifyAdapter} notify - Toastr-backed adapter for the import commit.
 * @returns {void}
 */
function triggerImport(notify) {
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
            const outcome = await importSummaryceptionMemory(data, { notify });
            if (outcome.status === 'invalid') {
                toastr.error('Invalid file format.');
                return;
            }
            if (outcome.status === 'failed') {
                toastr.error('Import failed - check console.');
                return;
            }
            toastr.success(`Memory imported. ${outcome.count} snippets loaded.`, TOAST_TITLE, {
                timeOut: 4000,
            });
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

    resetSettingsToDefaults();

    saveAndRefreshUi();
    toastr.success(
        'Advanced settings reset to defaults. Memory mode, connection settings, and summary memory were preserved.',
        TOAST_TITLE,
        { timeOut: 4000 },
    );
}

/**
 * Bind action button click handlers (clear, refresh, export, import, reset).
 * @param {import('../core/notify.js').NotifyAdapter} notify - Toastr-backed adapter for the import commit.
 * @returns {void}
 */
function bindClickHandlers(notify) {
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

    $(document).on('click', '#sc_import', () => triggerImport(notify));

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
