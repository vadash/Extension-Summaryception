import {
    MEMORY_MODES,
    MEMORY_POSITIONS,
    UI_MODES,
    defaultSettings,
    layerLabel,
    listNonEmptyLayers,
} from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import { warn } from '../foundation/logger.js';
import {
    getEffectiveSettings,
    getSettings,
    getChatStore,
    getCurrentSummarizedBoundary,
} from '../foundation/state.js';
import { getIsSummarizing } from '../core/summarizer.js';
import { countTextTokens, formatCompactTokenCount, formatTokenValue } from '../core/token-count.js';

import { buildAutoSummaryRoutePlan } from '../core/summarization-routes.js';
import { getEffectiveMemoryUsage } from '../core/memory-budget.js';
import { assembleSummaryBlock } from '../features/injection.js';
import { syncAllSettingsToDOM, syncRoleMaskModeControl } from './ui-bind.js';
import { updateSnippetBrowser } from './ui-snippets.js';
import { syncConnectionPanels } from './ui-connection.js';

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

        syncRoleMaskModeControl(s.maskUserRoleAsAssistant);
        // alwaysOn category: the input is disabled in markup, so reflect it as
        // permanently ticked rather than reading the (ignored) persisted flag.
        $('#sc_state_cat_date_time').prop('checked', true);
        const plan = await buildAutoSummaryRoutePlan(getChat(), store, effectiveSettings).catch(
            () => null,
        );
        const ghostedCount = getGhostedCount();
        const metrics = {
            totalSnippets: listNonEmptyLayers(store).reduce((n, { layer }) => n + layer.length, 0),
        };

        const overview = { settings: effectiveSettings, plan, ghostedCount, metrics };
        await renderStatusOverview('sc_status', 'enabled', overview);
        await renderStatusOverview('sc_easy_status', 'mode', overview);
        await renderBudgetStatus(effectiveSettings, store, plan);
        await renderMemoryBudget(effectiveSettings, store, 'easy_memory');
        renderLayerStats(effectiveSettings, store, ghostedCount);
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
    syncAllSettingsToDOM(s);
    syncEasyPayloadSchematic(effectiveSettings);
    syncMemoryModeControls(s);
    syncLLMContextPreview(s);
    syncConnectionPanels(s);
}

function syncEnabledContent(s) {
    // Show the off banner when the extension is off, but keep the complexity
    // panel (chosen via configMode) visible below it so configuration stays
    // editable while off; turning off no longer hides the settings UI.
    const off = s.uiMode === UI_MODES.OFF;
    const complexity = off ? s.configMode || UI_MODES.EASY : s.uiMode;
    $('#sc_off_content').toggle(off);
    $('#sc_easy_content').toggle(complexity === UI_MODES.EASY);
    $('#sc_enabled_content').toggle(complexity === UI_MODES.ADVANCED);
    // Stop latches autoPaused; show Resume while paused so users can continue
    // without re-triggering automatic work while they finish changing settings.
    const paused = Boolean(s.autoPaused);
    $('#sc_stop_summarize, #sc_easy_stop_summarize').toggle(s.enabled && !paused);
    $('#sc_resume_summarize, #sc_easy_resume_summarize').toggle(s.enabled && paused);
}

function syncEasyPayloadSchematic(s = getEffectiveSettings()) {
    $('#sc_easy_payload_memory_budget').text(formatBudgetTokenLabel(s.memoryTokenBudget));
    $('#sc_easy_payload_verbatim_budget').text(formatBudgetTokenLabel(s.verbatimTokenBudget));
    $('#sc_easy_payload_queued_budget').text(formatBudgetTokenLabel(s.queuedTokenBudget));
}

/**
 * Build configured recent/queued context limits for the main request preview.
 * @param {ReturnType<typeof getSettings>} [s]
 * @returns {{ rawChatMin: number, rawChatMax: number, mainMin: number, mainMax: number }}
 */
export function buildMainContextPreviewModel(s = getEffectiveSettings()) {
    const memoryBudget = readTokenSetting(s, 'memoryTokenBudget');
    const verbatimBudget = readTokenSetting(s, 'verbatimTokenBudget');
    const queuedBudget = readTokenSetting(s, 'queuedTokenBudget');
    return {
        rawChatMin: verbatimBudget,
        rawChatMax: verbatimBudget + queuedBudget,
        mainMin: memoryBudget + verbatimBudget,
        mainMax: memoryBudget + verbatimBudget + queuedBudget,
    };
}

/**
 *
 */
export function syncLLMContextPreview(s = getEffectiveSettings()) {
    const model = buildMainContextPreviewModel(s);
    const maxL0Source = readTokenSetting(s, 'maxL0SourceTokens');
    const minL0Source = readTokenSetting(s, 'minSummaryBudget');
    const memoryBudget = readTokenSetting(s, 'memoryTokenBudget');
    const snippetsPerPromotion = readTokenSetting(s, 'snippetsPerPromotion');
    const summaryTarget = readTokenSetting(s, 'layer0SummaryTokenTarget');
    const BASE_PROMPT_OVERHEAD = 2000;
    const DEEP_MEMORY_RATIO = 0.5;
    const l0Typical = minL0Source + memoryBudget + BASE_PROMPT_OVERHEAD;
    const l0Max = maxL0Source + memoryBudget + BASE_PROMPT_OVERHEAD;
    const l1Source = snippetsPerPromotion * summaryTarget;
    const l1Total = l1Source + Math.round(memoryBudget * DEEP_MEMORY_RATIO) + 1000;
    const $mainValue = $('#sc_llm_context_main');
    const $l0Value = $('#sc_llm_context_l0');
    const $l1Value = $('#sc_llm_context_l1');
    $mainValue.text(
        `${formatCompactTokenCount(model.mainMin)} → ${formatCompactTokenCount(model.mainMax)} + ST prompt`,
    );
    $l0Value.text(
        `~${formatCompactTokenCount(l0Typical)} (Max ~${formatCompactTokenCount(l0Max)})`,
    );
    $l1Value.text(`Max ~${formatCompactTokenCount(l1Total)} tokens`);
    setContextValueColor($mainValue, model.mainMax);
    setContextValueColor($l0Value, l0Typical);
    setContextValueColor($l1Value, l1Total);
}

function readTokenSetting(settings, key) {
    const number = Number(settings[key]);
    return Number.isFinite(number) ? number : defaultSettings[key];
}

function setContextValueColor($element, tokens) {
    $element.removeClass(CONTEXT_COLOR_CLASSES).addClass(getContextColorClass(tokens));
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

async function renderStatusOverview(prefix, modeField, overview) {
    const { settings: s, plan, ghostedCount, metrics } = overview;
    $(`#${prefix}_${modeField}`).text(getModeLabel(s));
    $(`#${prefix}_worker`).text(await getWorkerLabel(s, plan));
    $(`#${prefix}_snippets`).text(String(metrics.totalSnippets));
    $(`#${prefix}_ghosted`).text(String(ghostedCount));
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

async function getWorkerLabel(s, plan) {
    if (getIsSummarizing()) {
        return 'Running';
    }
    if (!s.enabled) {
        return 'Off';
    }

    const backlogCount = plan?.ready ? Math.max(plan.batchTurns.length, plan.overflowCount) : 0;
    return backlogCount > 0 ? `Backlog ${backlogCount}` : 'Idle';
}

function syncMemoryModeControls(s) {
    const isPrefixCache = s.memoryMode === MEMORY_MODES.PREFIX_CACHE;
    const isMacroOnly = s.customMemoryPosition === MEMORY_POSITIONS.MACRO_ONLY;
    $('#sc_custom_memory_depth_row').toggle(s.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT);
    $('#sc_custom_memory_role_row').toggle(!isMacroOnly);
    $('#sc_macro_memory_note').toggle(isMacroOnly);
    $('#sc_memory_help_balanced').toggle(s.memoryMode === MEMORY_MODES.BALANCED);
    $('#sc_memory_help_prefix_cache').toggle(isPrefixCache);
    $('#sc_manual_cache_warning').toggle(isPrefixCache);
    $('.sc-cache-mode-row').toggle(isPrefixCache);
}

function getGhostedCount() {
    try {
        const chat = getChat();
        return resolveScIdsToIndices(chat, getChatStore().ghostedMessageIds).length;
    } catch (_e) {
        return 0;
    }
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
 * @param {{ budget: number, verbatim: ContextBudgetTokenPart, layers: ContextBudgetTokenPart[], wrapper?: ContextBudgetTokenPart | null, marker?: { positionTokens: number, label: string } | null }} input
 * @returns {{ budget: number, used: number, overage: number, denominator: number, totalLabel: string, marker: { percent: number, label: string } | null, segments: Array<ContextBudgetTokenPart & { percent: number, small: boolean }> }}
 */
export function buildContextBudgetViewModel({
    budget,
    verbatim,
    layers,
    wrapper = null,
    marker = null,
}) {
    const normalizedBudget = normalizeBudgetCount(budget);
    const parts = [verbatim, ...layers, wrapper].filter(isVisibleBudgetPart);
    const used = parts.reduce((sum, part) => sum + part.count, 0);
    const overage = Math.max(0, used - normalizedBudget);
    const freeCount = Math.max(0, normalizedBudget - used);
    const anyEstimated = parts.some((part) => part.estimated);
    const markerTokens = marker ? normalizeBudgetCount(marker.positionTokens) : 0;
    const denominator = Math.max(normalizedBudget, used, markerTokens, 1);

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
        marker: marker
            ? { percent: Math.min(100, (markerTokens / denominator) * 100), label: marker.label }
            : null,
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

async function renderBudgetStatus(s, store, plan) {
    await renderVerbatimBudget(s, plan);
    await renderTriggerGauge(s, plan);
    await renderMemoryBudget(s, store);
}

/**
 * Render a context budget card into the `#sc_<prefix>_budget_{total,bar,legend}`
 * selector triple, clearing it when the view model cannot be built.
 * @param {string} prefix
 * @param {Function} build - Returns the buildContextBudgetViewModel inputs.
 * @returns {Promise<void>}
 */
async function renderBudgetCard(prefix, build) {
    const total = `#sc_${prefix}_budget_total`;
    const bar = `#sc_${prefix}_budget_bar`;
    const legend = `#sc_${prefix}_budget_legend`;
    try {
        renderBudgetView(buildContextBudgetViewModel(await build()), { total, bar, legend });
    } catch (e) {
        warn(`${prefix} budget render error:`, e);
        clearBudgetView(total, bar, legend);
    }
}

async function renderVerbatimBudget(s, plan) {
    await renderBudgetCard('verbatim', () => {
        if (!plan) {
            throw new Error('Summary route plan unavailable');
        }
        const stats = plan.rawPlan.verbatimStats || { finalTokens: 0, finalTokensEstimated: false };
        return {
            budget: s.verbatimTokenBudget,
            verbatim: {
                label: 'Recent Chat',
                kind: 'verbatim',
                count: stats.finalTokens,
                estimated: stats.finalTokensEstimated,
            },
            layers: [],
        };
    });
}

async function renderTriggerGauge(s, plan) {
    await renderBudgetCard('trigger', () => {
        if (!plan) {
            throw new Error('Summary route plan unavailable');
        }
        const model = buildTriggerGaugeModel(plan, s);
        return {
            budget: model.triggerTokens,
            verbatim: {
                label: 'Queued',
                kind: 'pending',
                count: model.queuedTokens,
                estimated: model.queuedEstimated,
            },
            layers: [],
            marker: { positionTokens: model.triggerTokens, label: model.label },
        };
    });
}

/**
 * Compute the queued-chat gauge from the unified planner.
 * @param {import('../core/summarization-routes.js').SummaryRoutePlan} plan
 * @param {ReturnType<typeof getEffectiveSettings>} s
 * @returns {{ queuedTokens: number, queuedEstimated: boolean, triggerTokens: number, label: string }}
 */
export function buildTriggerGaugeModel(plan, s) {
    const queuedStats = plan.rawPlan?.queuedStats;
    return {
        queuedTokens: normalizeBudgetCount(queuedStats?.finalTokens ?? 0),
        queuedEstimated: Boolean(queuedStats?.finalTokensEstimated),
        triggerTokens: normalizeBudgetCount(s.queuedTokenBudget),
        label: 'Summarize at Recent + Queued',
    };
}

async function renderMemoryBudget(s, store, prefix = 'memory') {
    await renderBudgetCard(prefix, async () => {
        const usage = await getEffectiveMemoryUsage(store.layers, s);
        return {
            budget: s.memoryTokenBudget,
            verbatim: { label: 'Live Chat', kind: 'verbatim', count: 0, estimated: false },
            layers: orderMemoryBudgetParts(usage.parts),
        };
    });
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
    const showOver = view.overage > 0;
    $(targets.total)
        .text(getContextBudgetTotalText(view))
        .toggleClass('sc-context-total-over', showOver);
    const bar = $(targets.bar).empty().toggleClass('sc-context-bar-over', showOver);
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

    if (view.marker) {
        $('<div class="sc-context-trigger-marker"></div>')
            .css('left', `${view.marker.percent}%`)
            .attr('title', view.marker.label)
            .append($('<span class="sc-context-trigger-flag"></span>').text(view.marker.label))
            .appendTo(bar);
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
 * @param {number} ghostedCount - Ghosted message count, computed once per updateUI.
 * @returns {void}
 */
function renderLayerStats(s, store, ghostedCount) {
    let statsHtml = `<div class="sc-layer-stat"><strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
    const nonEmptyLayers = listNonEmptyLayers(store);
    for (const { index, layer } of nonEmptyLayers) {
        statsHtml += `<div class="sc-layer-stat">
        <span class="sc-layer-label">${layerLabel(index)}:</span>
        <strong>${layer.length}</strong> / ${s.snippetsPerLayer} memories
        </div>`;
    }
    const boundary = getCurrentSummarizedBoundary(getChat(), store);
    if (boundary >= 0) {
        statsHtml += `<div class="sc-layer-stat sc-muted">Current summarized boundary: ${boundary}</div>`;
    }
    if (nonEmptyLayers.length === 0) {
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
