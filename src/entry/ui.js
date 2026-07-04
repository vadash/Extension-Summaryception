import { PROMPT_PRESETS } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';
import {
    calculateContiguousSummarizedUpTo,
    getSettings,
    saveSettings,
    getChatStore,
    saveChatStore,
} from '../foundation/state.js';
import { buildPassageFromRangeWithStats } from '../core/chatutils.js';
import { unghostMessagesInRange } from '../core/ghosting.js';
import { callSummarizer, getIsSummarizing, setSummarizing } from '../core/summarizer.js';
import { withUsageRun } from '../core/summarizer-usage.js';
import { getLayer0OverflowPlan } from '../core/verbatim-window.js';
import { assembleSummaryBlock, updateInjection } from '../features/injection.js';

/**
 * Re-render the entire Summaryception UI from current settings and chat store.
 * @returns {Promise<void>}
 */
export async function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        syncSettingsInputs(s);
        ensurePromptPresetMigrated(s);

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_apply_regex_scripts').prop('checked', s.applyRegexScripts);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        await renderOverview(s, store);
        renderLayerStats(s, store);
        renderPreview();
        updateSnippetBrowser();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

/**
 * Sync all static settings inputs from the settings object.
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
function syncSettingsInputs(s) {
    $('#sc_enabled').prop('checked', s.enabled);
    $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
    $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
    $('#sc_verbatim_token_budget').val(s.verbatimTokenBudget);
    $('#sc_verbatim_token_budget_val').text(s.verbatimTokenBudget);
    $('#sc_min_summary_budget').val(s.minSummaryBudget);
    $('#sc_min_summary_budget_val').text(s.minSummaryBudget);
    $('#sc_min_summary_turns').val(s.minSummaryTurns);
    $('#sc_min_summary_turns_val').text(s.minSummaryTurns);
    $('#sc_max_summary_turns').val(s.maxSummaryTurns);
    $('#sc_max_summary_turns_val').text(s.maxSummaryTurns);
    $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
    $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
    $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
    $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
    $('#sc_max_layers').val(s.maxLayers);
    $('#sc_max_layers_val').text(s.maxLayers);
    $('#sc_injection_template').val(s.injectionTemplate);
    $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
    $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
}

/**
 * Migrate prompt presets for existing users: empty/old-default -> narrative, custom -> 'custom'.
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
function ensurePromptPresetMigrated(s) {
    if (s.promptPreset) {
        return;
    }
    const currentPrompt = (s.summarizerUserPrompt || '').trim();
    const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

    if (!currentPrompt || currentPrompt === gameStatePrompt) {
        s.promptPreset = 'narrative';
        s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
        saveSettings();
    } else {
        s.promptPreset = 'custom';
        saveSettings();
    }
}

async function renderOverview(s, store) {
    const metrics = getLayerMetrics(store);
    const ghostedCount = getGhostedCount();

    $('#sc_status_enabled').text(getModeLabel(s));
    $('#sc_status_worker').text(await getWorkerLabel(s, store));
    $('#sc_status_snippets').text(String(metrics.totalSnippets));
    $('#sc_status_depth').text(String(metrics.deepestLayer));
    $('#sc_status_ghosted').text(String(ghostedCount));
    $('#sc_status_index').text(String(store.summarizedUpTo ?? -1));
}

function getModeLabel(s) {
    return s.enabled ? (s.pauseSummarization ? 'Paused' : 'Enabled') : 'Disabled';
}

async function getWorkerLabel(s, store) {
    if (getIsSummarizing()) {
        return 'Running';
    }
    if (!s.enabled) {
        return 'Off';
    }
    if (s.pauseSummarization) {
        return 'Paused';
    }

    const backlogCount = await getVisibleBacklogCount(s, store);
    return backlogCount > 0 ? `Backlog ${backlogCount}` : 'Idle';
}

async function getVisibleBacklogCount(s, store) {
    try {
        const plan = await getLayer0OverflowPlan(getChat(), store, s);
        return plan.reason === 'none' ? 0 : Math.max(plan.batchTurns.length, plan.overflowCount);
    } catch (_e) {
        return 0;
    }
}

function getGhostedCount() {
    try {
        const chat = getChat();
        return chat.filter((m) => m.extra?.sc_ghosted).length;
    } catch (_e) {
        return 0;
    }
}

function getLayerMetrics(store) {
    const layers = Array.isArray(store.layers) ? store.layers : [];
    let totalSnippets = 0;
    let deepestLayer = 0;
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        totalSnippets += layer.length;
        deepestLayer = i;
    }
    return { totalSnippets, deepestLayer };
}

/**
 * Build and render the layer statistics panel.
 * @param {ReturnType<typeof getSettings>} s
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {void}
 */
function renderLayerStats(s, store) {
    const ghostedCount = getGhostedCount();

    let statsHtml = '';
    if (s.disableGhosting) {
        statsHtml += `<div class="sc-layer-stat"><strong>${ghostedCount}</strong> messages ghosted (metadata only; not visually hidden)</div>`;
    } else {
        statsHtml += `<div class="sc-layer-stat"><strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
    }
    if (store.layers) {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (layer && layer.length > 0) {
                const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
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
}

/**
 * Build and render the injection preview textarea.
 * @returns {void}
 */
function renderPreview() {
    const preview = assembleSummaryBlock();
    $('#sc_preview').val(preview || '(empty - no summaries yet)');
}

/**
 * Render the custom prompt slot dropdown.
 * @returns {void}
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

    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

/**
 * Render the snippet browser and bind its per-snippet action handlers.
 * @returns {void}
 */
export function updateSnippetBrowser() {
    const store = getChatStore();
    const html = buildSnippetBrowserHtml(store);
    $('#sc_snippet_browser').html(html);

    bindSnippetEditHandlers(store);
    bindSnippetRedoHandlers(store);
    bindSnippetDeleteHandlers(store);
}

/**
 * Build the snippet browser HTML string.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {string}
 */
function buildSnippetBrowserHtml(store) {
    if (!store.layers || store.layers.every((l) => !l || l.length === 0)) {
        return '<div class="sc-muted">No snippets to display.</div>';
    }

    let html = '';
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
                ? `turns ${sn.turnRange[0]}-${sn.turnRange[1]}`
                : sn.mergedCount
                  ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                  : '';
            const seedStr = sn.promoted ? ' promoted' : '';
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
    return html;
}

/**
 * Bind click-to-edit handlers for snippet text.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {void}
 */
function bindSnippetEditHandlers(store) {
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
                            toastr.success('Snippet updated', 'Summaryception', {
                                timeOut: 1500,
                            });
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
                        toastr.success('Snippet updated', 'Summaryception', {
                            timeOut: 1500,
                        });
                    }
                    updateSnippetBrowser();
                });

            textEl.replaceWith(textarea);

            textarea[0].style.height = 'auto';
            textarea[0].style.height = textarea[0].scrollHeight + 'px';

            textarea.focus().select();
        });
}

/**
 * Collect existing snippet context (excluding one specific index).
 * @param {ReturnType<typeof getChatStore>} store
 * @param {number} excludeLayerIdx
 * @param {number} excludeSnippetIdx
 * @returns {string}
 */
function buildSnippetContext(store, excludeLayerIdx, excludeSnippetIdx) {
    const contextParts = [];
    for (let i = store.layers.length - 1; i >= 0; i--) {
        const l = store.layers[i];
        if (!l) {
            continue;
        }
        for (let j = 0; j < l.length; j++) {
            if (i === excludeLayerIdx && j === excludeSnippetIdx) {
                continue;
            }
            contextParts.push(l[j].text);
        }
    }
    return contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';
}

/**
 * Handle regenerate (redo) click for a single layer-0 snippet.
 * @param {ReturnType<typeof getChatStore>} store
 * @param {any} btn
 * @param {number} layerIdx
 * @param {number} snippetIdx
 * @returns {Promise<void>}
 */
async function regenerateSnippet(store, btn, layerIdx, snippetIdx) {
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
    const chat = getChat();

    if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) {
        return;
    }

    setSummarizing(true);
    btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');

    try {
        await withUsageRun('snippet regeneration', async () => {
            const passage = await buildPassageFromRangeWithStats(chat, rangeStart, rangeEnd);
            const storyTxt = passage.text;

            if (!storyTxt.trim()) {
                toastr.error('Source turns are empty - cannot regenerate.', 'Summaryception');
                return;
            }

            const contextStr = buildSnippetContext(store, layerIdx, snippetIdx);

            toastr.info(
                `Regenerating summary for turns ${rangeStart}-${rangeEnd}...`,
                'Summaryception',
                {
                    timeOut: 3000,
                    progressBar: true,
                },
            );

            const newSummary = await callSummarizer(storyTxt, contextStr, {
                kind: 'regenerate',
                sourceRange: [rangeStart, rangeEnd],
                regexStats: passage.stats,
            });

            if (!newSummary) {
                toastr.error('Regeneration failed - original snippet kept.', 'Summaryception');
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
                {
                    timeOut: 3000,
                },
            );
        });
    } finally {
        setSummarizing(false);
        btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
    }
}

/**
 * Bind regenerate (redo) handlers for layer 0 snippet action.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {void}
 */
function bindSnippetRedoHandlers(store) {
    $('.sc-snippet-redo')
        .off('click')
        .on('click', async function () {
            const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
            const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
            await regenerateSnippet(store, $(this), layerIdx, snippetIdx);
        });
}

/**
 * Bind delete handlers for snippet browser entries.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {void}
 */
function bindSnippetDeleteHandlers(store) {
    $('.sc-snippet-delete')
        .off('click')
        .on('click', async function () {
            const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
            const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
            const layer = store.layers[layerIdx];
            if (layer) {
                const removed = layer[snippetIdx];
                layer.splice(snippetIdx, 1);

                if (layerIdx === 0) {
                    store.summarizedUpTo = calculateContiguousSummarizedUpTo(store);
                    const range = getSnippetTurnRange(removed);
                    if (range) {
                        await unghostMessagesInRange(range[0], range[1]);
                    }
                }

                await saveChatStore();
                updateInjection();
                updateUI();
                toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
            }
        });
}

/**
 * Get a valid turn range from a snippet.
 * @param {object} snippet
 * @returns {[number, number] | null}
 */
function getSnippetTurnRange(snippet) {
    const range = snippet?.turnRange;
    if (!Array.isArray(range) || range.length < 2) {
        return null;
    }
    if (!Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
        return null;
    }
    return range[0] >= 0 && range[1] >= range[0] ? /** @type {[number, number]} */ (range) : null;
}

/**
 * Escape a string for safe HTML rendering.
 *
 * Uses vanilla DOM instead of jQuery: this is the canonical XSS-safe idiom
 * (textContent + innerHTML) with zero wrapper overhead.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
