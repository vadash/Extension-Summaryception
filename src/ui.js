import { LOG_PREFIX, defaultSettings, PROMPT_PRESETS } from './constants.js';
import {
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
} from './connectionutil.js';
import { log } from './logger.js';
import { getSettings, saveSettings, getChatStore, saveChatStore } from './state.js';
import { ghostMessagesUpTo, unghostAllMessages } from './ghosting.js';
import { getAssistantTurns, buildPassageFromRange } from './chatutils.js';
import {
    abortSummarization,
    callSummarizer,
    getIsSummarizing,
    hasActiveAbortController,
    resetCatchupDismissed,
    runCatchup,
    setSummarizing,
} from './summarizer.js';
import { assembleSummaryBlock, updateInjection } from './injection.js';
import { persistAndRefresh } from './persist.js';
import { clearSummaryceptionMemory } from './memory.js';

// ─── Settings UI ─────────────────────────────────────────────────────

/**
 *
 */
export function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        // ── Prompt preset migration & sync ──
        // Migration: existing users with the old game-state default get upgraded to narrative.
        // Users who customized their prompt get marked as 'custom'.
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                // User had the old default — upgrade to narrative
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                // User customized their prompt — mark as custom
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter((m) => m.extra?.sc_ghosted).length;
        } catch (_e) {
            /* no chat loaded */
        }

        let statsHtml = '';
        if (s.disableGhosting) {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (metadata only — not visually hidden)</div>`;
        } else {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        }
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label =
                        i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every((l) => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateSnippetBrowser();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

/**
 *
 */
export function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append($('<option></option>').val(name).text(`${name}`).attr('title', preview));
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

/**
 *
 */
export function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every((l) => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) {
                continue;
            }
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                      ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                      : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = i === 0 && sn.turnRange;
                const redoBtn = canRedo
                    ? '<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>'
                    : '';

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text')
        .off('click')
        .on('click', function () {
            const layerIdx = parseInt($(this).data('layer'));
            const snippetIdx = parseInt($(this).data('idx'));
            const layer = store.layers[layerIdx];
            if (!layer || !layer[snippetIdx]) {
                return;
            }

            const sn = layer[snippetIdx];
            const textEl = $(this);

            const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
                .val(sn.text)
                .on('keydown', async function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const newText = $(this).val().trim();
                        if (newText) {
                            sn.text = newText;
                            await saveChatStore();
                            updateInjection();
                            toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                        }
                        updateSnippetBrowser();
                    } else if (e.key === 'Escape') {
                        updateSnippetBrowser();
                    }
                })
                .on('blur', async function () {
                    const newText = $(this).val().trim();
                    if (newText && newText !== sn.text) {
                        sn.text = newText;
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                    }
                    updateSnippetBrowser();
                });

            textEl.replaceWith(textarea);

            // Auto-size to fit content
            textarea[0].style.height = 'auto';
            textarea[0].style.height = textarea[0].scrollHeight + 'px';

            textarea.focus().select();
        });

    // Redo snippet
    $('.sc-snippet-redo')
        .off('click')
        .on('click', async function () {
            const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
            const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
            const store = getChatStore();
            const layer = store.layers[layerIdx];
            if (!layer || !layer[snippetIdx]) {
                return;
            }

            const sn = layer[snippetIdx];

            if (!sn.turnRange) {
                toastr.warning(
                    'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
                    'Summaryception',
                    { timeOut: 5000 },
                );
                return;
            }

            if (getIsSummarizing()) {
                toastr.warning('Already summarizing. Please wait.', 'Summaryception');
                return;
            }

            const [rangeStart, rangeEnd] = /** @type {Array<number>} */ (sn.turnRange);
            const { chat } = SillyTavern.getContext();

            if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) {
                return;
            }

            setSummarizing(true);
            const btn = $(this);
            btn.prop('disabled', true)
                .removeClass('fa-rotate-right')
                .addClass('fa-spinner fa-spin');

            try {
                const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);

                if (!storyTxt.trim()) {
                    toastr.error('Source turns are empty — cannot regenerate.', 'Summaryception');
                    return;
                }

                const contextParts = [];
                for (let i = store.layers.length - 1; i >= 0; i--) {
                    const l = store.layers[i];
                    if (!l) {
                        continue;
                    }
                    for (let j = 0; j < l.length; j++) {
                        if (i === layerIdx && j === snippetIdx) {
                            continue;
                        }
                        contextParts.push(l[j].text);
                    }
                }
                const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

                toastr.info(
                    `Regenerating summary for turns ${rangeStart}–${rangeEnd}…`,
                    'Summaryception',
                    {
                        timeOut: 3000,
                        progressBar: true,
                    },
                );

                const newSummary = await callSummarizer(storyTxt, contextStr);

                if (!newSummary) {
                    toastr.error('Regeneration failed — original snippet kept.', 'Summaryception');
                    return;
                }

                sn.text = newSummary;
                sn.timestamp = Date.now();
                sn.regenerated = true;

                await saveChatStore();
                updateInjection();
                updateUI();

                toastr.success(
                    `Snippet regenerated for turns ${rangeStart}–${rangeEnd}`,
                    'Summaryception',
                    { timeOut: 3000 },
                );
            } finally {
                setSummarizing(false);
                btn.prop('disabled', false)
                    .removeClass('fa-spinner fa-spin')
                    .addClass('fa-rotate-right');
            }
        });

    // Delete snippet
    $('.sc-snippet-delete')
        .off('click')
        .on('click', async function () {
            const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
            const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
            const layer = store.layers[layerIdx];
            if (layer) {
                layer.splice(snippetIdx, 1);

                if (store.layers[0] && store.layers[0].length > 0) {
                    const maxEnd = Math.max(
                        ...store.layers[0]
                            .filter((sn) => sn.turnRange)
                            .map((sn) => /** @type {Array<number>} */ (sn.turnRange)[1]),
                    );
                    store.summarizedUpTo = maxEnd;
                } else {
                    store.summarizedUpTo = -1;
                }

                await saveChatStore();
                updateInjection();
                updateUI();
                toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
            }
        });
}

/**
 *
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 *
 */
export function bindUIEvents() {
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

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
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
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) {
            return;
        }

        await clearSummaryceptionMemory({ updateUi: true });
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', async function () {
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
    });

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

    $(document).on('click', '#sc_import', function () {
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
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
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
                // Auto-save before we switch to custom
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            // Keep lastCustomPrompt in sync while editing in custom mode
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
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

    // ── Custom Prompt: Load from named slot ──
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

    // ── Custom Prompt: Delete named slot ──
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

    // ── Custom Prompt: Export as .txt ──
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

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
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
    });

    $(document).on('click', '#sc_reset_defaults', function () {
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

        saveSettings();
        updateInjection();
        updateUI();

        toastr.success(
            'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
            'Summaryception',
            { timeOut: 4000 },
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

/**
 *
 */
export function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    // ── Source dropdown ──
    const sourceSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_connection_source')
    );
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_connection_profile')
    );
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = /** @type {HTMLInputElement} */ (
        document.getElementById('summaryception_ollama_url')
    );
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_ollama_model')
    );
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = /** @type {HTMLButtonElement} */ (
        document.getElementById('summaryception_ollama_refresh')
    );
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = /** @type {HTMLInputElement} */ (
        document.getElementById('summaryception_openai_url')
    );
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = /** @type {HTMLInputElement} */ (
        document.getElementById('summaryception_openai_key')
    );
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = /** @type {HTMLInputElement} */ (
        document.getElementById('summaryception_openai_model')
    );
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = /** @type {HTMLInputElement} */ (
        document.getElementById('summaryception_openai_max_tokens')
    );
    if (openaiMaxTokens) {
        openaiMaxTokens.value = String(s().openaiMaxTokens || 0);
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = /** @type {HTMLButtonElement} */ (
        document.getElementById('summaryception_openai_test')
    );
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

/**
 *
 */
export function updateConnectionSubPanels(/** @type {string} */ source) {
    const panels = {
        profile: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_profile_settings')
        ),
        ollama: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_ollama_settings')
        ),
        openai: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_openai_settings')
        ),
    };

    Object.values(panels).forEach((panel) => {
        if (panel) {
            panel.style.display = 'none';
        }
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

/**
 *
 */
export function populateOllamaModelDropdown(
    /** @type {HTMLSelectElement} */ selectElement,
    models,
    currentValue,
) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

/**
 *
 */
export async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_ollama_model')
    );

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map((m) => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

/**
 *
 */
export async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

/**
 *
 */
export function showConnectionStatus(/** @type {string} */ type, /** @type {string} */ message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) {
        return;
    }

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) {
                container.style.display = 'none';
            }
        }, 8000);
    }
}

/**
 *
 */
export async function fetchProfilesFallback(
    /** @type {HTMLSelectElement} */ selectElement,
    currentValue,
) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}
