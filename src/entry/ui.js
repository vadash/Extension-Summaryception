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
 * @typedef {object} SnippetBrowserItem
 * @property {string} key - Stable row key for this render pass
 * @property {number} layerIndex - Source layer index
 * @property {number} snippetIndex - Source snippet index within the layer
 * @property {string} text - Snippet text
 * @property {string} meta - Compact source metadata label
 * @property {boolean} canRedo - Whether the row can be regenerated
 */

/**
 * @typedef {object} SnippetBrowserLayer
 * @property {string} key - Stable layer key for this render pass
 * @property {number} index - Source layer index
 * @property {string} label - Layer heading
 * @property {SnippetBrowserItem[]} snippets - Snippets in display order
 */

/**
 * @typedef {object} SnippetBrowserView
 * @property {boolean} empty - Whether there are no snippets to display
 * @property {SnippetBrowserLayer[]} layers - Non-empty layers, deepest first
 */

const SNIPPET_BROWSER_EVENT_NS = '.summaryceptionSnippetBrowser';

/**
 * Render the snippet browser with fine-grained DOM updates.
 * @returns {void}
 */
export function updateSnippetBrowser() {
    const store = getChatStore();
    const browser = $('#sc_snippet_browser');
    if (!browser.length) {
        return;
    }

    bindSnippetBrowserHandlers(browser);
    renderSnippetBrowser(browser, buildSnippetBrowserViewModel(store));
}

/**
 * Build a DOM-neutral view model for the snippet browser.
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {SnippetBrowserView}
 */
export function buildSnippetBrowserViewModel(store) {
    const layers = [];
    const sourceLayers = Array.isArray(store.layers) ? store.layers : [];
    for (let i = sourceLayers.length - 1; i >= 0; i--) {
        const layer = sourceLayers[i];
        if (!layer || layer.length === 0) {
            continue;
        }
        const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
        layers.push({
            key: getSnippetLayerKey(i),
            index: i,
            label,
            snippets: layer.map((snippet, j) => buildSnippetBrowserItem(snippet, i, j)),
        });
    }
    return { empty: layers.length === 0, layers };
}

/**
 * Build the stable row key used by the snippet browser renderer.
 * @param {number} layerIndex
 * @param {number} snippetIndex
 * @returns {string}
 */
export function getSnippetBrowserRowKey(layerIndex, snippetIndex) {
    return `snippet:${layerIndex}:${snippetIndex}`;
}

function getSnippetLayerKey(layerIndex) {
    return `layer:${layerIndex}`;
}

function buildSnippetBrowserItem(snippet, layerIndex, snippetIndex) {
    return {
        key: getSnippetBrowserRowKey(layerIndex, snippetIndex),
        layerIndex,
        snippetIndex,
        text: snippet.text,
        meta: getSnippetMeta(snippet),
        canRedo: Boolean(layerIndex === 0 && snippet.turnRange),
    };
}

function getSnippetMeta(snippet) {
    const rangeStr = snippet.turnRange
        ? `turns ${snippet.turnRange[0]}-${snippet.turnRange[1]}`
        : snippet.mergedCount
          ? `merged ${snippet.mergedCount} from L${snippet.fromLayer}`
          : '';
    const seedStr = snippet.promoted ? ' promoted' : '';
    return `${rangeStr}${seedStr}`;
}

function bindSnippetBrowserHandlers(browser) {
    if (browser.data('scSnippetBrowserHandlersBound')) {
        return;
    }

    browser.data('scSnippetBrowserHandlersBound', true);
    browser
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-text', onSnippetTextClick)
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-redo', onSnippetRedoClick)
        .on(`click${SNIPPET_BROWSER_EVENT_NS}`, '.sc-snippet-delete', onSnippetDeleteClick);
}

function renderSnippetBrowser(browser, view) {
    const previousScrollTop = browser.scrollTop();

    if (view.empty) {
        renderEmptySnippetBrowser(browser);
        browser.scrollTop(previousScrollTop);
        return;
    }

    browser.children('.sc-muted').remove();
    removeMissingLayers(browser, new Set(view.layers.map((layer) => layer.key)));

    let cursor = null;
    for (const layer of view.layers) {
        const layerEl = getOrCreateLayerElement(browser, layer);
        updateLayerElement(layerEl, layer);
        renderLayerSnippets(layerEl, layer);
        cursor = placeElementAfterCursor(browser, layerEl, cursor);
    }

    browser.scrollTop(previousScrollTop);
}

function renderEmptySnippetBrowser(browser) {
    if (hasFocusedSnippetEdit(browser)) {
        return;
    }

    browser.children().remove();
    $('<div class="sc-muted"></div>').text('No snippets to display.').appendTo(browser);
}

function removeMissingLayers(browser, layerKeys) {
    browser.children('.sc-browser-layer').each(function () {
        const layerEl = $(this);
        if (!layerKeys.has(layerEl.attr('data-key')) && !hasFocusedSnippetEdit(layerEl)) {
            layerEl.remove();
        }
    });
}

function getOrCreateLayerElement(browser, layer) {
    const existing = browser
        .children('.sc-browser-layer')
        .filter(function () {
            return $(this).attr('data-key') === layer.key;
        })
        .first();

    if (existing.length) {
        return existing;
    }

    return $('<div class="sc-browser-layer"></div>');
}

function updateLayerElement(layerEl, layer) {
    layerEl.attr({ 'data-key': layer.key, 'data-layer': String(layer.index) });

    let title = layerEl.children('.sc-browser-layer-title').first();
    if (!title.length) {
        title = $('<div class="sc-browser-layer-title"></div>').prependTo(layerEl);
    }
    title.text(layer.label);
}

function renderLayerSnippets(layerEl, layer) {
    const rowKeys = new Set(layer.snippets.map((snippet) => snippet.key));
    removeMissingSnippetRows(layerEl, rowKeys);

    let cursor = layerEl.children('.sc-browser-layer-title').first();
    for (const snippet of layer.snippets) {
        const row = getOrCreateSnippetRow(layerEl, snippet);
        updateSnippetRow(row, snippet);
        cursor = placeElementAfterCursor(layerEl, row, cursor);
    }
}

function placeElementAfterCursor(parent, element, cursor) {
    if (cursor?.length) {
        if (!cursor.next().is(element)) {
            element.insertAfter(cursor);
        }
        return element;
    }

    if (!parent.children().first().is(element)) {
        parent.prepend(element);
    }
    return element;
}

function removeMissingSnippetRows(layerEl, rowKeys) {
    layerEl.children('.sc-snippet').each(function () {
        const row = $(this);
        if (!rowKeys.has(row.attr('data-key')) && !hasFocusedSnippetEdit(row)) {
            row.remove();
        }
    });
}

function getOrCreateSnippetRow(layerEl, snippet) {
    const existing = layerEl
        .children('.sc-snippet')
        .filter(function () {
            return $(this).attr('data-key') === snippet.key;
        })
        .first();

    if (existing.length) {
        return existing;
    }

    return $('<div class="sc-snippet"></div>');
}

function updateSnippetRow(row, snippet) {
    row.attr({
        'data-key': snippet.key,
        'data-layer': String(snippet.layerIndex),
        'data-idx': String(snippet.snippetIndex),
    });

    if (hasFocusedSnippetEdit(row)) {
        return;
    }

    row.children('.sc-snippet-edit').remove();
    const text = ensureSnippetText(row, snippet);
    const meta = ensureSnippetMeta(row, snippet);
    const redo = ensureSnippetRedo(row, snippet);
    const remove = ensureSnippetDelete(row);

    row.append(text, meta);
    if (redo) {
        row.append(redo);
    }
    row.append(remove);
}

function ensureSnippetText(row, snippet) {
    let text = row.children('.sc-snippet-text').first();
    if (!text.length) {
        text = $('<span class="sc-snippet-text"></span>');
    }
    text.attr({
        'data-layer': String(snippet.layerIndex),
        'data-idx': String(snippet.snippetIndex),
        title: 'Click to edit',
    });
    text.text(snippet.text);
    return text;
}

function ensureSnippetMeta(row, snippet) {
    let meta = row.children('.sc-snippet-meta').first();
    if (!meta.length) {
        meta = $('<span class="sc-snippet-meta"></span>');
    }
    meta.text(snippet.meta);
    return meta;
}

function ensureSnippetRedo(row, snippet) {
    let redo = row.children('.sc-snippet-redo').first();
    if (!snippet.canRedo) {
        redo.remove();
        return null;
    }
    if (!redo.length) {
        redo = $('<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right"></button>');
    }
    redo.attr({
        type: 'button',
        title: 'Regenerate this snippet',
        'aria-label': 'Regenerate this snippet',
    });
    return redo;
}

function ensureSnippetDelete(row) {
    let remove = row.children('.sc-snippet-delete').first();
    if (!remove.length) {
        remove = $('<button class="sc-snippet-delete menu_button fa-solid fa-xmark"></button>');
    }
    remove.attr({
        type: 'button',
        title: 'Delete this snippet',
        'aria-label': 'Delete this snippet',
    });
    return remove;
}

function hasFocusedSnippetEdit(scope) {
    return scope.find('.sc-snippet-edit:focus').length > 0;
}

function onSnippetTextClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const store = getChatStore();
    const snippet = store.layers[position.layerIdx]?.[position.snippetIdx];
    if (!snippet) {
        return;
    }

    startSnippetEdit($(this), snippet);
}

function getSnippetPosition(element) {
    const row = element.closest('.sc-snippet');
    const layerIdx = Number.parseInt(String(row.attr('data-layer')), 10);
    const snippetIdx = Number.parseInt(String(row.attr('data-idx')), 10);

    if (!Number.isInteger(layerIdx) || !Number.isInteger(snippetIdx)) {
        return null;
    }
    return { layerIdx, snippetIdx };
}

function startSnippetEdit(textEl, snippet) {
    let finished = false;
    const textarea = $('<textarea class="sc-snippet-edit"></textarea>').val(snippet.text);
    const finish = async (shouldSave) => {
        if (finished) {
            return;
        }
        finished = true;
        try {
            if (shouldSave) {
                await commitSnippetEdit(textarea, snippet);
            }
        } finally {
            updateSnippetBrowser();
        }
    };

    textarea
        .on('keydown', async function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                await finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                await finish(false);
            }
        })
        .on('blur', async () => {
            await finish(true);
        });

    textEl.replaceWith(textarea);
    resizeSnippetEdit(textarea);
    textarea.focus().select();
}

async function commitSnippetEdit(textarea, snippet) {
    const newText = String(textarea.val()).trim();
    if (!newText || newText === snippet.text) {
        return;
    }

    snippet.text = newText;
    await saveChatStore();
    updateInjection();
    toastr.success('Snippet updated', 'Summaryception', {
        timeOut: 1500,
    });
}

function resizeSnippetEdit(textarea) {
    const element = textarea[0];
    if (!element) {
        return;
    }
    element.style.height = 'auto';
    element.style.height = element.scrollHeight + 'px';
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

async function onSnippetRedoClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    await regenerateSnippet(getChatStore(), $(this), position.layerIdx, position.snippetIdx);
}

async function onSnippetDeleteClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const store = getChatStore();
    const layer = store.layers[position.layerIdx];
    if (!layer || !layer[position.snippetIdx]) {
        return;
    }

    const removed = layer[position.snippetIdx];
    layer.splice(position.snippetIdx, 1);

    if (position.layerIdx === 0) {
        store.summarizedUpTo = calculateContiguousSummarizedUpTo(store);
        const range = getSnippetTurnRange(removed);
        if (range) {
            await unghostMessagesInRange(range[0], range[1]);
        }
    }

    await saveChatStore();
    updateInjection();
    updateUI();
    toastr.info(`Snippet removed from Layer ${position.layerIdx}`, 'Summaryception');
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
