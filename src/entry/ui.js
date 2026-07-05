import { MEMORY_MODES, MEMORY_POSITIONS } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';
import { getSettings, getChatStore } from '../foundation/state.js';
import { getIsSummarizing } from '../core/summarizer.js';
import { countTextTokens, formatTokenCount } from '../core/token-count.js';
import { getCacheFriendlyPlan } from '../core/cache-planner.js';
import { getLayer0OverflowPlan } from '../core/verbatim-window.js';
import { assembleSummaryBlock } from '../features/injection.js';
import {
    deleteSnippetAt,
    getSnippetRegenerationTarget,
    getSnippetTextAt,
    regenerateSnippetAt,
    updateSnippetTextAt,
} from '../features/snippet-manager.js';

/**
 * Re-render the entire Summaryception UI from current settings and chat store.
 * @returns {Promise<void>}
 */
export async function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        syncSettingsInputs(s);

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_prompt_log_mode').prop('checked', s.promptLogMode);
        $('#sc_apply_regex_scripts').prop('checked', s.applyRegexScripts);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);
        syncConnectionInputs(s);

        await renderOverview(s, store);
        await renderBudgetStatus(s, store);
        await renderCacheStatus(s, store);
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
    $(`input[name="sc_memory_mode"][value="${s.memoryMode}"]`).prop('checked', true);
    $('#sc_custom_memory_position').val(s.customMemoryPosition);
    $('#sc_custom_memory_role').val(s.customMemoryRole);
    $('#sc_custom_memory_depth').val(s.customMemoryDepth);
    $('#sc_verbatim_token_budget').val(s.verbatimTokenBudget);
    $('#sc_verbatim_token_budget_val').text(s.verbatimTokenBudget);
    $('#sc_memory_token_budget').val(s.memoryTokenBudget);
    $('#sc_memory_token_budget_val').text(s.memoryTokenBudget);
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
    $('#sc_injection_template').val(s.injectionTemplate);
    $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
    $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
    syncMemoryModeControls(s);
}

/**
 * Sync connection inputs that can change outside initConnectionUI.
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
function syncConnectionInputs(s) {
    $('#summaryception_connection_source').val(s.connectionSource || 'default');
    $('#summaryception_connection_profile').val(s.connectionProfileId);
    $('#summaryception_ollama_url, #summaryception_merge_ollama_url').val(s.ollamaUrl);
    $('#summaryception_ollama_model').val(s.ollamaModel);
    $('#summaryception_openai_url, #summaryception_merge_openai_url').val(s.openaiUrl);
    $('#summaryception_openai_key, #summaryception_merge_openai_key').val(s.openaiKey);
    $('#summaryception_openai_model').val(s.openaiModel);
    $('#summaryception_openai_max_tokens').val(s.openaiMaxTokens || 0);
    $('#summaryception_merge_connection_source').val(s.mergeConnectionSource || 'inherit');
    $('#summaryception_merge_connection_profile').val(s.mergeConnectionProfileId);
    $('#summaryception_merge_ollama_model').val(s.mergeOllamaModel);
    $('#summaryception_merge_openai_model').val(s.mergeOpenaiModel);
    $('#summaryception_merge_openai_max_tokens').val(s.mergeOpenaiMaxTokens || 0);
    $('#sc_merge_summarizer_response_length').val(s.mergeSummarizerResponseLength || 0);
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
    return s.enabled ? 'Enabled' : 'Disabled';
}

async function getWorkerLabel(s, store) {
    if (getIsSummarizing()) {
        return 'Running';
    }
    if (!s.enabled) {
        return 'Off';
    }

    const backlogCount = await getVisibleBacklogCount(s, store);
    return backlogCount > 0 ? `Backlog ${backlogCount}` : 'Idle';
}

async function getVisibleBacklogCount(s, store) {
    try {
        if (s.memoryMode === MEMORY_MODES.CACHE) {
            const plan = await getCacheFriendlyPlan(getChat(), store, s);
            return plan.reason === 'ready'
                ? Math.max(plan.batchTurns.length, plan.overflowCount)
                : 0;
        }
        const plan = await getLayer0OverflowPlan(getChat(), store, s);
        return plan.reason === 'none' ? 0 : Math.max(plan.batchTurns.length, plan.overflowCount);
    } catch (_e) {
        return 0;
    }
}

function syncMemoryModeControls(s) {
    const isCache = s.memoryMode === MEMORY_MODES.CACHE;
    const isCustom = s.memoryMode === MEMORY_MODES.CUSTOM;

    $('#sc_custom_memory_controls').toggle(isCustom);
    $('#sc_custom_memory_depth_row').toggle(
        isCustom && s.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT,
    );
    $('#sc_memory_help_standard').toggle(s.memoryMode === MEMORY_MODES.STANDARD);
    $('#sc_memory_help_cache').toggle(isCache);
    $('#sc_memory_help_custom').toggle(isCustom);
    $('#sc_manual_cache_warning').toggle(isCache);
    $('#sc_cache_status_section').toggle(isCache);
    $('#sc_min_summary_turns, #sc_max_summary_turns').prop('disabled', false);
    $('#sc_min_summary_turns, #sc_max_summary_turns').closest('.sc-row').removeClass('sc-disabled');
    $('#sc_min_summary_budget_hint').text(
        'Overflow passage tokens to collect before summarizing short batches.',
    );
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
 * @typedef {object} ContextBudgetTokenPart
 * @property {string} label
 * @property {string} kind
 * @property {number} count
 * @property {boolean} estimated
 */

/**
 * Build a DOM-neutral token budget view model.
 * @param {{ budget: number, verbatim: ContextBudgetTokenPart, layers: ContextBudgetTokenPart[], wrapper?: ContextBudgetTokenPart | null }} input
 * @returns {{ budget: number, used: number, overage: number, denominator: number, totalLabel: string, segments: Array<ContextBudgetTokenPart & { percent: number, small: boolean }> }}
 */
export function buildContextBudgetViewModel({ budget, verbatim, layers, wrapper = null }) {
    const normalizedBudget = normalizeBudgetCount(budget);
    const parts = [verbatim, ...layers, wrapper].filter(isVisibleBudgetPart);
    const used = parts.reduce((sum, part) => sum + part.count, 0);
    const overage = Math.max(0, used - normalizedBudget);
    const freeCount = Math.max(0, normalizedBudget - used);
    const anyEstimated = parts.some((part) => part.estimated);
    const denominator = Math.max(normalizedBudget, used, 1);
    const segments = parts.map((part) => buildBudgetSegment(part, denominator));

    if (freeCount > 0) {
        segments.push(
            buildBudgetSegment(
                { label: 'Free Space', kind: 'free', count: freeCount, estimated: false },
                denominator,
            ),
        );
    }

    return {
        budget: normalizedBudget,
        used,
        overage,
        denominator,
        totalLabel: `${formatBudgetTokenLabel(used, anyEstimated)} / ${formatBudgetTokenLabel(
            normalizedBudget,
            false,
        )}`,
        segments,
    };
}

/**
 * Format a budget token count.
 * @param {number} count
 * @param {boolean} estimated
 * @returns {string}
 */
export function formatBudgetTokenLabel(count, estimated = false) {
    return formatTokenCount({ count: normalizeBudgetCount(count), estimated });
}

async function renderBudgetStatus(s, store) {
    await renderVerbatimBudget(s, store);
    await renderMemoryBudget(s, store);
}

async function renderVerbatimBudget(s, store) {
    try {
        const view = buildContextBudgetViewModel({
            budget: s.verbatimTokenBudget,
            verbatim: await getVerbatimBudgetPart(s, store),
            layers: [],
        });
        renderBudgetView(view, {
            total: '#sc_verbatim_budget_total',
            bar: '#sc_verbatim_budget_bar',
            legend: '#sc_verbatim_budget_legend',
        });
    } catch (e) {
        log('Verbatim budget render error:', e);
        clearBudgetView(
            '#sc_verbatim_budget_total',
            '#sc_verbatim_budget_bar',
            '#sc_verbatim_budget_legend',
        );
    }
}

async function renderMemoryBudget(s, store) {
    try {
        const layers = await getLayerBudgetParts(store);
        const view = buildContextBudgetViewModel({
            budget: s.memoryTokenBudget,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 0, estimated: false },
            layers,
            wrapper: await getWrapperBudgetPart(store, layers),
        });
        renderBudgetView(view, {
            total: '#sc_memory_budget_total',
            bar: '#sc_memory_budget_bar',
            legend: '#sc_memory_budget_legend',
        });
    } catch (e) {
        log('Memory budget render error:', e);
        clearBudgetView(
            '#sc_memory_budget_total',
            '#sc_memory_budget_bar',
            '#sc_memory_budget_legend',
        );
    }
}

async function renderCacheStatus(s, store) {
    if (s.memoryMode !== MEMORY_MODES.CACHE) {
        return;
    }

    try {
        const plan = await getCacheFriendlyPlan(getChat(), store, s);
        $('#sc_cache_live_tokens').text(formatBudgetTokenLabel(plan.liveTokens));
        $('#sc_cache_budget').text(formatBudgetTokenLabel(plan.cacheBudget));
        $('#sc_cache_tail_tokens').text(formatBudgetTokenLabel(plan.protectedTailTokens));
        $('#sc_cache_flush_tokens').text(formatBudgetTokenLabel(plan.estimatedFlushTokens));
        $('#sc_cache_ready_state').text(getCacheReadyStateText(plan));
    } catch (e) {
        log('Cache status render error:', e);
        $('#sc_cache_ready_state').text('Unavailable');
    }
}

function getCacheReadyStateText(plan) {
    if (plan.reason === 'ready') {
        return `Ready: ${plan.batchTurns.length} / ${plan.overflowCount} turns`;
    }
    if (plan.tokenBudgetExceeded) {
        return 'Waiting for a flushable assistant turn';
    }
    return 'Within cache budget';
}

async function getVerbatimBudgetPart(s, store) {
    const plan = await getLayer0OverflowPlan(getChat(), store, s);
    return {
        label: 'Verbatim Window',
        kind: 'verbatim',
        count: plan.budgetStats.finalTokens,
        estimated: plan.budgetStats.finalTokensEstimated,
    };
}

async function getLayerBudgetParts(store) {
    const layers = Array.isArray(store.layers) ? store.layers : [];
    const parts = [];
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        const text = layer.map((snippet) => snippet.text).join(' ');
        const tokens = await countTextTokens(text);
        parts.push({
            label: `Layer ${i}`,
            kind: i === 0 ? 'layer0' : 'layer',
            count: tokens.count,
            estimated: tokens.estimated,
        });
    }
    return parts;
}

async function getWrapperBudgetPart(store, layerParts) {
    if (!store.layers?.some((layer) => Array.isArray(layer) && layer.length > 0)) {
        return null;
    }

    const fullTokens = await countTextTokens(assembleSummaryBlock());
    const layerTotal = layerParts.reduce((sum, part) => sum + part.count, 0);
    const wrapperCount = Math.max(0, fullTokens.count - layerTotal);
    return {
        label: 'Memory Wrapper',
        kind: 'wrapper',
        count: wrapperCount,
        estimated: fullTokens.estimated || layerParts.some((part) => part.estimated),
    };
}

function renderBudgetView(view, targets) {
    $(targets.total).text(getContextBudgetTotalText(view));
    const bar = $(targets.bar).empty();
    const legend = $(targets.legend).empty();

    for (const segment of view.segments) {
        $('<div></div>')
            .addClass(`sc-context-segment sc-context-${segment.kind}`)
            .toggleClass('sc-context-segment-small', segment.small)
            .css('flex', `${Math.max(segment.count, 1)} 1 0`)
            .attr('title', getBudgetSegmentTitle(segment))
            .text(`${segment.label} (${formatBudgetTokenLabel(segment.count, segment.estimated)})`)
            .appendTo(bar);
        renderBudgetLegendItem(legend, segment);
    }
}

function clearBudgetView(totalSelector, barSelector, legendSelector) {
    $(totalSelector).text('Unavailable');
    $(barSelector).empty();
    $(legendSelector).empty();
}

function renderBudgetLegendItem(legend, segment) {
    const item = $('<div class="sc-context-legend-item"></div>');
    $('<span class="sc-context-swatch"></span>')
        .addClass(`sc-context-${segment.kind}`)
        .appendTo(item);
    $('<span class="sc-context-legend-text"></span>')
        .text(`${segment.label}: ${formatBudgetTokenLabel(segment.count, segment.estimated)}`)
        .attr('title', getBudgetSegmentTitle(segment))
        .appendTo(item);
    item.appendTo(legend);
}

function getContextBudgetTotalText(view) {
    if (view.overage > 0) {
        return `${view.totalLabel} (+${formatBudgetTokenLabel(view.overage, false)})`;
    }
    return view.totalLabel;
}

function buildBudgetSegment(part, denominator) {
    const percent = denominator > 0 ? (part.count / denominator) * 100 : 0;
    return {
        ...part,
        percent,
        small: percent < 8,
    };
}

function getBudgetSegmentTitle(segment) {
    return `${segment.label}: ${formatBudgetTokenLabel(segment.count, segment.estimated)} tokens`;
}

/**
 * @param {ContextBudgetTokenPart | null | undefined} part
 * @returns {part is ContextBudgetTokenPart}
 */
function isVisibleBudgetPart(part) {
    return Boolean(part && normalizeBudgetCount(part.count) > 0);
}

function normalizeBudgetCount(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
        return 0;
    }
    return Math.max(0, Math.ceil(count));
}

/**
 * Build and render the layer statistics panel.
 * @param {ReturnType<typeof getSettings>} s
 * @param {ReturnType<typeof getChatStore>} store
 * @returns {void}
 */
function renderLayerStats(s, store) {
    const ghostedCount = getGhostedCount();

    let statsHtml = `<div class="sc-layer-stat"><strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
    if (store.layers) {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (layer && layer.length > 0) {
                const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                statsHtml += `<div class="sc-layer-stat">
                <span class="sc-layer-label">${label}:</span>
                <strong>${layer.length}</strong> / ${s.snippetsPerLayer} memories
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

    const snippetText = getSnippetTextAt(position.layerIdx, position.snippetIdx);
    if (snippetText.status !== 'found') {
        return;
    }

    startSnippetEdit($(this), position, snippetText.text);
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

function startSnippetEdit(textEl, position, initialText) {
    let finished = false;
    const textarea = $('<textarea class="sc-snippet-edit"></textarea>').val(initialText);
    const finish = async (shouldSave) => {
        if (finished) {
            return;
        }
        finished = true;
        try {
            if (shouldSave) {
                await commitSnippetEdit(textarea, position);
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

async function commitSnippetEdit(textarea, position) {
    const result = await updateSnippetTextAt(
        position.layerIdx,
        position.snippetIdx,
        textarea.val(),
    );
    if (result.status === 'updated') {
        toastr.success('Snippet updated', 'Summaryception', {
            timeOut: 1500,
        });
    }
}

function resizeSnippetEdit(textarea) {
    const element = textarea[0];
    if (!element) {
        return;
    }
    element.style.height = 'auto';
    element.style.height = element.scrollHeight + 'px';
}

async function onSnippetRedoClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const target = getSnippetRegenerationTarget(position.layerIdx, position.snippetIdx);
    if (target.status !== 'ready') {
        handleRegenerationTargetStatus(target);
        return;
    }
    if (!confirm(`Regenerate summary for turns ${target.range[0]}-${target.range[1]}?`)) {
        return;
    }

    toastr.info(
        `Regenerating summary for turns ${target.range[0]}-${target.range[1]}...`,
        'Summaryception',
        {
            timeOut: 3000,
            progressBar: true,
        },
    );
    await runSnippetRegeneration($(this), position);
}

async function onSnippetDeleteClick() {
    const position = getSnippetPosition($(this));
    if (!position) {
        return;
    }

    const result = await deleteSnippetAt(position.layerIdx, position.snippetIdx);
    if (result.status === 'deleted') {
        updateUI();
        toastr.info(`Snippet removed from Layer ${result.layerIndex}`, 'Summaryception');
    }
}

function handleRegenerationTargetStatus(target) {
    if (target.status === 'ready') {
        return true;
    }
    if (target.status === 'busy') {
        toastr.warning('Already summarizing. Please wait.', 'Summaryception');
        return false;
    }
    if (target.status === 'unsupported') {
        toastr.warning(
            'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
            'Summaryception',
            { timeOut: 5000 },
        );
    }
    return false;
}

async function runSnippetRegeneration(btn, position) {
    btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');
    try {
        const result = await regenerateSnippetAt(position.layerIdx, position.snippetIdx);
        handleRegenerationResult(result);
    } finally {
        btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
    }
}

function handleRegenerationResult(result) {
    if (result.status === 'regenerated') {
        updateUI();
        toastr.success(
            `Snippet regenerated for turns ${result.range[0]}-${result.range[1]}`,
            'Summaryception',
            { timeOut: 3000 },
        );
        return;
    }
    if (result.status === 'empty-source') {
        toastr.error('Source turns are empty - cannot regenerate.', 'Summaryception');
    } else if (result.status === 'failed') {
        toastr.error('Regeneration failed - original snippet kept.', 'Summaryception');
    } else if (result.status === 'busy') {
        toastr.warning('Already summarizing. Please wait.', 'Summaryception');
    } else if (result.status === 'unsupported') {
        handleRegenerationTargetStatus(result);
    }
}
