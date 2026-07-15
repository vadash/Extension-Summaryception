import {
    MEMORY_MODES,
    MEMORY_POSITIONS,
    UI_MODES,
    defaultSettings,
} from '../foundation/constants.js';
import {
    estimateMainPromptTokens,
    getChat,
    isSendButtonInStopMode,
} from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { getEffectiveSettings, getSettings, getChatStore } from '../foundation/state.js';
import { getIsSummarizing } from '../core/summarizer.js';
import { countTextTokens, formatTokenValue } from '../core/token-count.js';
import { getProtectedTailTokens } from '../core/cache-planner.js';
import { buildAutoSummaryRoutePlan } from '../core/summarization-routes.js';
import { getEffectiveMemoryUsage } from '../core/memory-budget.js';
import { assembleSummaryBlock } from '../features/injection.js';
import { SETTINGS_HELP } from './settings-help.js';
import {
    deleteSnippetAt,
    getSnippetRegenerationTarget,
    getSnippetTextAt,
    regenerateSnippetAt,
    updateSnippetTextAt,
} from '../features/snippet-manager.js';
import {
    SETTING_SLIDER_SELECTOR,
    syncDataSettingElements,
    syncRoleMaskModeControl,
    syncSliderSettingPairs,
} from './ui-bind.js';

const CONNECTION_DATA_SETTING_SELECTOR = '#summaryception_connection_settings [data-sc-setting]';
const CONTEXT_COLOR_CLASSES = 'sc-ctx-safe sc-ctx-warn sc-ctx-caution sc-ctx-danger';

/**
 * Re-render the entire Summaryception UI from current settings and chat store.
 * @returns {Promise<void>}
 */
export async function updateUI() {
    try {
        const s = getSettings();
        const effectiveSettings = getEffectiveSettings();
        const store = getChatStore();

        syncSettingsInputs(s, effectiveSettings);
        syncEnabledContent(s);

        $('#sc_summarizer_system_prompt_preset').val(s.summarizerSystemPromptPreset);
        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_summarizer_repair_prompt_preset').val(s.summarizerRepairPromptPreset);
        $('#sc_promotion_system_prompt_preset').val(s.promotionSystemPromptPreset);
        $('#sc_promotion_prompt_preset').val(s.promotionPromptPreset);
        $('#sc_promotion_repair_prompt_preset').val(s.promotionRepairPromptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_prompt_input_log_mode').prop('checked', s.promptInputLogMode);
        $('#sc_prompt_output_log_mode').prop('checked', s.promptOutputLogMode);
        $('#sc_apply_regex_scripts').prop('checked', s.applyRegexScripts);
        $('#sc_strip_chinese_ideographs').prop('checked', s.stripChineseIdeographs);
        $('#sc_mask_user_role_as_assistant').prop('checked', s.maskUserRoleAsAssistant);
        $('#sc_mask_user_role_mode').val(s.maskUserRoleMode);
        syncRoleMaskModeControl(s.maskUserRoleAsAssistant);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);
        syncConnectionInputs(s);

        await renderOverview(effectiveSettings, store);
        await renderEasyOverview(effectiveSettings, store);
        await renderBudgetStatus(effectiveSettings, store);
        await renderEasyBudgetStatus(effectiveSettings, store);
        renderLayerStats(effectiveSettings, store);
        await renderPreview();
        updateSnippetBrowser();
    } catch (e) {
        warn('updateUI error:', e);
    }
}

/**
 * Sync all static settings inputs from the settings object.
 * @param {ReturnType<typeof getSettings>} s
 * @param {ReturnType<typeof getEffectiveSettings>} effectiveSettings
 * @returns {void}
 */
function syncSettingsInputs(s, effectiveSettings) {
    $('#sc_enabled').prop('checked', s.enabled);
    $(`input[name="sc_ui_mode"][value="${s.uiMode}"]`).prop('checked', true);
    $('#sc_easy_connection_source').val(s.easyConnectionSource || 'default');
    $('#sc_easy_connection_profile').val(s.easyConnectionProfileId || '');
    $('#sc_easy_merge_connection_source').val(s.easyMergeConnectionSource || 'inherit');
    $('#sc_easy_merge_connection_profile').val(s.easyMergeConnectionProfileId || '');
    $(`input[name="sc_easy_memory_mode"][value="${s.easyMemoryMode}"]`).prop('checked', true);
    $(`input[name="sc_memory_mode"][value="${s.memoryMode}"]`).prop('checked', true);
    $('#sc_custom_memory_position').val(s.customMemoryPosition);
    $('#sc_custom_memory_role').val(s.customMemoryRole);
    $('#sc_custom_memory_depth').val(s.customMemoryDepth);
    syncSliderSettingPairs(SETTING_SLIDER_SELECTOR, s);
    $('#sc_injection_template').val(s.injectionTemplate);
    $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
    $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
    $('#sc_summarizer_repair_prompt').val(s.summarizerRepairPrompt);
    $('#sc_promotion_system_prompt').val(s.promotionSystemPrompt);
    $('#sc_promotion_user_prompt').val(s.promotionUserPrompt);
    $('#sc_promotion_repair_prompt').val(s.promotionRepairPrompt);
    syncPayloadSchematic(effectiveSettings);
    syncEasyPayloadSchematic(effectiveSettings);
    syncMemoryModeControls(s);
    syncLLMContextPreview(s);
    syncEasyConnectionPanels(s);
}

function syncEnabledContent(s) {
    $('#sc_off_content').toggle(s.uiMode === UI_MODES.OFF);
    $('#sc_easy_content').toggle(s.uiMode === UI_MODES.EASY);
    $('#sc_enabled_content').toggle(s.uiMode === UI_MODES.ADVANCED);
}

/**
 * Sync read-only context payload budget labels.
 * @param {ReturnType<typeof getSettings>} [s]
 * @returns {void}
 */
export function syncPayloadSchematic(s = getEffectiveSettings()) {
    const isCache = s.memoryMode === MEMORY_MODES.CACHE;
    const protectedTail = getProtectedTailTokens(s.verbatimTokenBudget);

    $('#sc_payload_memory_budget').text(formatBudgetTokenLabel(s.memoryTokenBudget));
    $('#sc_payload_verbatim_budget').text(
        formatBudgetTokenLabel(
            isCache ? s.verbatimTokenBudget - protectedTail : s.verbatimTokenBudget,
        ),
    );
    $('#sc_payload_tail_budget').text(formatBudgetTokenLabel(protectedTail));
    $('#sc_payload_tail_part').css('display', isCache ? 'contents' : 'none');
}

function syncEasyPayloadSchematic(s = getEffectiveSettings()) {
    $('#sc_easy_payload_memory_budget').text(formatBudgetTokenLabel(s.memoryTokenBudget));
    $('#sc_easy_payload_verbatim_budget').text(formatBudgetTokenLabel(s.verbatimTokenBudget));
}

/**
 * Sync read-only LLM call context preview.
 * @param {ReturnType<typeof getSettings>} [s]
 * @returns {void}
 */
export function syncLLMContextPreview(s = getEffectiveSettings()) {
    const maxL0Source = readTokenSetting(s.maxL0SourceTokens, defaultSettings.maxL0SourceTokens);
    const minL0Source = readTokenSetting(s.minSummaryBudget, defaultSettings.minSummaryBudget);
    const memoryBudget = readTokenSetting(s.memoryTokenBudget, defaultSettings.memoryTokenBudget);
    const verbatimBudget = readTokenSetting(
        s.verbatimTokenBudget,
        defaultSettings.verbatimTokenBudget,
    );
    const snippetsPerPromotion = readTokenSetting(
        s.snippetsPerPromotion,
        defaultSettings.snippetsPerPromotion,
    );
    const summaryTarget = readTokenSetting(
        s.layer0SummaryTokenTarget,
        defaultSettings.layer0SummaryTokenTarget,
    );

    const BASE_PROMPT_OVERHEAD = 2000;
    const DEEP_MEMORY_RATIO = 0.5;

    const mainBudget = memoryBudget + verbatimBudget;
    const l0Typical = minL0Source + memoryBudget + BASE_PROMPT_OVERHEAD;
    const l0Max = maxL0Source + memoryBudget + BASE_PROMPT_OVERHEAD;
    const l1Source = snippetsPerPromotion * summaryTarget;
    const l1Total = l1Source + Math.round(memoryBudget * DEEP_MEMORY_RATIO) + 1000;

    const $mainValue = $('#sc_llm_context_main');
    const $l0Value = $('#sc_llm_context_l0');
    const $l1Value = $('#sc_llm_context_l1');

    $mainValue.text(`Max ~${formatContextTokenCount(mainBudget)} + ST prompt`);
    if (minL0Source < maxL0Source) {
        $l0Value.text(
            `~${formatContextTokenCount(l0Typical)} (Max ~${formatContextTokenCount(l0Max)})`,
        );
        setContextValueColor($l0Value, l0Typical);
    } else {
        $l0Value.text(`Max ~${formatContextTokenCount(l0Max)} tokens`);
        setContextValueColor($l0Value, l0Max);
    }
    $l1Value.text(`Max ~${formatContextTokenCount(l1Total)} tokens`);

    setContextValueColor($mainValue, mainBudget);
    setContextValueColor($l1Value, l1Total);
}

/**
 * Refresh the current SillyTavern main prompt estimate on demand.
 * @returns {Promise<void>}
 */
export async function refreshMainLLMContextEstimate() {
    const $value = $('#sc_llm_context_main');
    const $button = $('#sc_estimate_main_context');
    if (!$value.length) {
        return;
    }
    if (isSendButtonInStopMode()) {
        $value.text('Busy').removeClass(CONTEXT_COLOR_CLASSES).addClass('sc-ctx-caution');
        return;
    }

    setMainEstimateButtonBusy($button, true);
    $value.text('Estimating...').removeClass(CONTEXT_COLOR_CLASSES);
    try {
        const tokens = await estimateMainPromptTokens();
        if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
            $value.text('Unavailable').addClass('sc-ctx-caution');
            return;
        }
        $value.text(`Actual ~${formatContextTokenCount(tokens)} tokens`);
        setContextValueColor($value, tokens);
    } catch (e) {
        warn('Main prompt estimate failed:', e);
        $value.text('Unavailable').addClass('sc-ctx-caution');
    } finally {
        setMainEstimateButtonBusy($button, false);
    }
}

function readTokenSetting(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function formatContextTokenCount(tokens) {
    if (tokens >= 1000) {
        const value = tokens / 1000;
        return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
    }
    return String(Math.max(0, Math.round(tokens)));
}

function setContextValueColor($element, tokens) {
    $element.removeClass(CONTEXT_COLOR_CLASSES).addClass(getContextColorClass(tokens));
}

function setMainEstimateButtonBusy($button, busy) {
    if (!$button.length) {
        return;
    }
    $button.prop('disabled', busy);
    const $icon = $button.find('i');
    if (busy) {
        $icon.removeClass('fa-calculator').addClass('fa-spinner fa-spin');
    } else {
        $icon.removeClass('fa-spinner fa-spin').addClass('fa-calculator');
    }
}

/**
 * Get color class based on token count thresholds.
 * @param {number} tokens
 * @returns {string}
 */
function getContextColorClass(tokens) {
    if (tokens > 48000) {
        return 'sc-ctx-danger';
    }
    if (tokens > 32000) {
        return 'sc-ctx-caution';
    }
    if (tokens > 24000) {
        return 'sc-ctx-warn';
    }
    return 'sc-ctx-safe';
}

/**
 * Sync connection inputs that can change outside initConnectionUI.
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
function syncConnectionInputs(s) {
    syncDataSettingElements(CONNECTION_DATA_SETTING_SELECTOR, s);
    $('#sc_easy_connection_source').val(s.easyConnectionSource || 'default');
    $('#sc_easy_connection_profile').val(s.easyConnectionProfileId || '');
    $('#sc_easy_merge_connection_source').val(s.easyMergeConnectionSource || 'inherit');
    $('#sc_easy_merge_connection_profile').val(s.easyMergeConnectionProfileId || '');
    $('#summaryception_connection_source').val(s.connectionSource || 'default');
    $('#summaryception_connection_profile').val(s.connectionProfileId);
    $('#summaryception_ollama_model').val(s.ollamaModel);
    $('#summaryception_merge_connection_source').val(s.mergeConnectionSource || 'inherit');
    $('#summaryception_merge_connection_profile').val(s.mergeConnectionProfileId);
    $('#summaryception_merge_ollama_model').val(s.mergeOllamaModel);
    $('#summaryception_fallback_connection_source').val(s.fallbackConnectionSource || 'disabled');
    $('#summaryception_fallback_connection_profile').val(s.fallbackConnectionProfileId);
    $('#summaryception_fallback_ollama_model').val(s.fallbackOllamaModel);
}

function syncEasyConnectionPanels(s) {
    $('#sc_easy_profile_settings').toggle(s.easyConnectionSource === 'profile');
    $('#sc_easy_merge_profile_settings').toggle(s.easyMergeConnectionSource === 'profile');
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

async function renderEasyOverview(s, store) {
    const metrics = getLayerMetrics(store);
    const ghostedCount = getGhostedCount();

    $('#sc_easy_status_mode').text(getModeLabel(s));
    $('#sc_easy_status_worker').text(await getWorkerLabel(s, store));
    $('#sc_easy_status_snippets').text(String(metrics.totalSnippets));
    $('#sc_easy_status_ghosted').text(String(ghostedCount));
}

function getModeLabel(s) {
    if (s.uiMode === UI_MODES.EASY) {
        return 'Easy';
    }
    if (s.uiMode === UI_MODES.ADVANCED) {
        return 'Advanced';
    }
    return 'Off';
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
        const plan = await buildAutoSummaryRoutePlan(getChat(), store, s);
        return plan.ready ? Math.max(plan.batchTurns.length, plan.overflowCount) : 0;
    } catch (_e) {
        return 0;
    }
}

function syncMemoryModeControls(s) {
    const isCache = s.memoryMode === MEMORY_MODES.CACHE;
    const isMacroOnly = s.customMemoryPosition === MEMORY_POSITIONS.MACRO_ONLY;

    $('#sc_custom_memory_depth_row').toggle(s.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT);
    $('#sc_custom_memory_role_row').toggle(!isMacroOnly);
    $('#sc_macro_memory_note').toggle(isMacroOnly);
    $('#sc_memory_help_standard').toggle(s.memoryMode === MEMORY_MODES.STANDARD);
    $('#sc_memory_help_cache').toggle(isCache);
    $('#sc_manual_cache_warning').toggle(isCache);
    $('#sc_min_summary_turns, #sc_max_summary_turns').prop('disabled', false);
    $('#sc_min_summary_turns, #sc_max_summary_turns').closest('.sc-row').removeClass('sc-disabled');
    $('#sc_min_summary_budget_hint').text(SETTINGS_HELP.min_summary_budget.short);
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
 * @property {string} label - Segment label for budget displays.
 * @property {string} kind - Segment category used for styling and ordering.
 * @property {number} count - Token count for the segment.
 * @property {boolean} estimated - Whether the count came from fallback estimation.
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
    return formatTokenValue(normalizeBudgetCount(count), estimated);
}

async function renderBudgetStatus(s, store) {
    await renderVerbatimBudget(s, store);
    await renderMemoryBudget(s, store);
}

async function renderEasyBudgetStatus(s, store) {
    await renderMemoryBudget(s, store, {
        total: '#sc_easy_memory_budget_total',
        bar: '#sc_easy_memory_budget_bar',
        legend: '#sc_easy_memory_budget_legend',
    });
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
        warn('Verbatim budget render error:', e);
        clearBudgetView(
            '#sc_verbatim_budget_total',
            '#sc_verbatim_budget_bar',
            '#sc_verbatim_budget_legend',
        );
    }
}

async function renderMemoryBudget(
    s,
    store,
    targets = {
        total: '#sc_memory_budget_total',
        bar: '#sc_memory_budget_bar',
        legend: '#sc_memory_budget_legend',
    },
) {
    try {
        const usage = await getEffectiveMemoryUsage(store.layers, s);
        const view = buildContextBudgetViewModel({
            budget: s.memoryTokenBudget,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 0, estimated: false },
            layers: orderMemoryBudgetParts(usage.parts),
        });
        renderBudgetView(view, targets);
    } catch (e) {
        warn('Memory budget render error:', e);
        clearBudgetView(targets.total, targets.bar, targets.legend);
    }
}

async function getVerbatimBudgetPart(s, store) {
    const plan = await buildAutoSummaryRoutePlan(getChat(), store, s);
    return {
        label: 'Verbatim Window',
        kind: 'verbatim',
        count: getRouteBudgetStats(plan).finalTokens,
        estimated: getRouteBudgetStats(plan).finalTokensEstimated,
    };
}

function getRouteBudgetStats(plan) {
    return plan.rawPlan.budgetStats || plan.rawPlan.liveStats;
}

function orderMemoryBudgetParts(parts) {
    return [...parts].sort((a, b) => getMemoryBudgetPartOrder(a) - getMemoryBudgetPartOrder(b));
}

function getMemoryBudgetPartOrder(part) {
    if (part.kind === 'state') {
        return -1;
    }
    if (part.kind === 'wrapper') {
        return Number.MAX_SAFE_INTEGER;
    }
    if (Number.isInteger(part.layerIndex)) {
        return part.layerIndex;
    }
    return Number.MAX_SAFE_INTEGER - 1;
}

function renderBudgetView(view, targets) {
    $(targets.total)
        .text(getContextBudgetTotalText(view))
        .toggleClass('sc-context-total-over', view.overage > 0);
    const bar = $(targets.bar)
        .empty()
        .toggleClass('sc-context-bar-over', view.overage > 0);
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
 * Build and render the injection preview textarea and token count.
 * @returns {Promise<void>}
 */
async function renderPreview() {
    const preview = assembleSummaryBlock();
    $('#sc_preview').val(preview || '(empty - no summaries yet)');
    if (!preview) {
        $('#sc_preview_token_count').text('0 tokens');
        return;
    }

    const tokens = await countTextTokens(preview);
    $('#sc_preview_token_count').text(
        `${formatBudgetTokenLabel(tokens.count, tokens.estimated)} tokens`,
    );
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
