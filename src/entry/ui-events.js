import { LOG_PREFIX, PROMPT_PRESETS, defaultSettings } from '../foundation/constants.js';
import { log } from '../foundation/logger.js';
import { getSettings, saveSettings, getChatStore } from '../foundation/state.js';
import { ghostMessagesUpTo, unghostAllMessages } from '../core/ghosting.js';
import { getAssistantTurns } from '../core/chatutils.js';
import {
    abortSummarization,
    getIsSummarizing,
    hasActiveAbortController,
    resetCatchupDismissed,
    runCatchup,
} from '../core/summarizer.js';
import { updateInjection } from '../features/injection.js';
import { persistAndRefresh } from '../features/persist.js';
import { clearSummaryceptionMemory } from '../features/memory.js';
import { updateUI, updateCustomPromptSlots } from './ui.js';

// ─── Event Bindings ──────────────────────────────────────────────────

/**
 * Bind document event handlers for the Summaryception UI.
 * @returns {void}
 */
export function bindUIEvents() {
    bindToggleHandlers();
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
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: 5000 },
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: 3000 },
            );
        }
    });

    $(document).on('change', '#sc_disable_ghosting', function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();

        if ($(this).prop('checked')) {
            toastr.info(
                'Message hiding disabled. Summarized messages will remain visible but still be excluded from LLM context via the sc_ghosted flag.',
                'Summaryception',
                { timeOut: 5000 },
            );
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

    $(document).on('change', '#sc_apply_regex_scripts', function () {
        getSettings().applyRegexScripts = $(this).prop('checked');
        saveSettings();
    });
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
    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        {
            id: '#sc_turns_per_summary',
            key: 'turnsPerSummary',
            display: '#sc_turns_per_summary_val',
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
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    bindInputHelpers();
}

/**
 * Bind handlers for non-prompt textarea settings.
 * @returns {void}
 */
function bindTextareaHandlers() {
    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }
}

/**
 * Scan chat for stuck-hidden (orphaned) messages and unhide them.
 * @returns {Promise<void>}
 */
async function onRepairOrphans() {
    const { chat } = SillyTavern.getContext();
    let repaired = 0;

    const progressToast = toastr.info(
        'Scanning for orphaned messages...',
        'Summaryception — Repair',
        { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false },
    );

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];

        const isStuckHidden =
            (m.is_system || m.is_hidden) &&
            !m.is_user &&
            !m.extra?.sc_ghosted &&
            m.mes &&
            m.mes.trim().length > 0;

        if (isStuckHidden) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, {
                    showOutput: false,
                });
            } catch (e) {
                log(`Repair: failed to unhide ${i}:`, e);
            }

            m.is_system = false;
            delete m.is_hidden;

            repaired++;

            if (repaired % 5 === 0) {
                $(progressToast)
                    .find('.toast-message')
                    .text(`Repairing: found ${repaired} orphaned messages...`);
            }
        }
    }

    toastr.clear(progressToast);

    if (repaired > 0) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) {
                await ctx.saveChat();
            }
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateUI();
        toastr.success(
            `Repaired ${repaired} orphaned messages. They are now visible to the summarizer again.`,
            'Summaryception',
            { timeOut: 5000 },
        );
    } else {
        toastr.info('No orphaned messages found.', 'Summaryception', { timeOut: 3000 });
    }
}

/**
 * Force the catch-up pass to summarize overflow turns beyond verbatim limit.
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
    if (s.pauseSummarization) {
        log('Force Summarize overrides pause mode.');
    }
    $(this).prop('disabled', true).text(' Working…');
    try {
        resetCatchupDismissed();

        const { chat } = SillyTavern.getContext();
        const allAssistantTurns = getAssistantTurns(chat);
        const visibleTurns = allAssistantTurns.filter((t) => !chat[t.index].extra?.sc_ghosted);

        if (visibleTurns.length <= s.verbatimTurns) {
            toastr.info(
                'Nothing to summarize — visible turns are within the verbatim limit.',
                'Summaryception',
            );
            return;
        }

        const overflow = visibleTurns.length - s.verbatimTurns;
        toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', {
            timeOut: 2000,
        });

        await runCatchup(visibleTurns, overflow);
        updateInjection();
    } finally {
        $(this)
            .prop('disabled', false)
            .html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
        updateUI();
    }
}

/**
 * Import summary memory from a JSON file.
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
                await ghostMessagesUpTo(store.summarizedUpTo);
            }

            await persistAndRefresh({ ui: true });
            toastr.success(
                `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                'Summaryception',
                { timeOut: 4000 },
            );
        } catch (err) {
            console.error(LOG_PREFIX, err);
            toastr.error('Import failed — check console.');
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
    s.verbatimTurns = defaultSettings.verbatimTurns;
    s.turnsPerSummary = defaultSettings.turnsPerSummary;
    s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
    s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;
    s.maxLayers = defaultSettings.maxLayers;

    // Reset prompts
    s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
    s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
    s.promptPreset = defaultSettings.promptPreset;
    s.injectionTemplate = defaultSettings.injectionTemplate;
    s.stripPatterns = [...defaultSettings.stripPatterns];
    s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

    // Reset debug
    s.debugMode = defaultSettings.debugMode;
    s.traceMode = defaultSettings.traceMode;
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
    $(document).on('click', '#sc_repair', onRepairOrphans);

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) {
            return;
        }

        await clearSummaryceptionMemory({ updateUi: true });
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', onForceSummarize);

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
    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
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
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
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
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
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
            console.error(LOG_PREFIX, err);
            toastr.error('Import failed — check console.', 'Summaryception');
        }
    };
    input.click();
}
