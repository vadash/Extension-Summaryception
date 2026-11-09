import {
    MEMORY_MODES,
    MEMORY_POSITIONS,
    layerLabel,
    listNonEmptyLayers,
} from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { readOperationMode } from '../foundation/operation-mode.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getEffectiveSettings, getSettings } from '../foundation/settings.js';
import { countGhostedMessages } from '../core/ghosting.js';
import { getCurrentSummarizedBoundary } from '../core/snippet-provenance.js';
import { formatCompactTokenCount } from '../core/token-count.js';

import { describeAutoWork } from '../core/summarization-routes.js';
import { describeMicroficheBilling, estimateContextPreview } from '../core/token-budget.js';
import { buildInjection, measureInjection } from '../core/memory-injection.js';
import {
    syncAllSettingsToDOM,
    syncGuardMaskMemoryControl,
    syncRoleMaskModeControl,
} from './ui-bind.js';
import { updateSnippetBrowser } from './ui-snippets.js';
import { syncConnectionPanels } from './ui-connection.js';
import {
    buildContextBudgetViewModel,
    buildEnabledContentModel,
    buildTriggerGaugeModel,
    formatBudgetTokenLabel,
    getContextColorClass,
} from './ui-view-models.js';

const CONTEXT_COLOR_CLASSES = 'sc-ctx-safe sc-ctx-warn sc-ctx-caution sc-ctx-danger';

/**
 * Re-render the entire Summaryception UI from current settings and chat store.
 * Entry re-renders through the Refresh Port, whose composition root binding
 * supplies the queue.
 * @param {{ queue: import('../core/summarizer-queue.js').SummarizerQueue }} deps
 * @returns {Promise<void>}
 */
export async function updateUI({ queue }) {
    try {
        const s = getSettings();
        const effectiveSettings = getEffectiveSettings();
        const store = getChatStore();

        const memoryInjection = buildInjection(store.layers, effectiveSettings);
        syncSettingsInputs(s, effectiveSettings, memoryInjection);
        const enabledContent = buildEnabledContentModel(readOperationMode(s), {
            autoPaused: s.autoPaused,
        });
        syncEnabledContent(enabledContent);

        syncRoleMaskModeControl(s.maskUserRoleAsAssistant);
        syncGuardMaskMemoryControl(Boolean(s.guardMask));
        const work = await describeAutoWork(getChat(), store, effectiveSettings).catch(() => null);
        const ghostedCount = countGhostedMessages();
        const metrics = {
            totalSnippets: listNonEmptyLayers(store).reduce((n, { layer }) => n + layer.length, 0),
        };

        const overview = {
            settings: effectiveSettings,
            modeLabel: enabledContent.modeLabel,
            work,
            ghostedCount,
            metrics,
            busy: queue.isBusy(),
        };
        const memoryUsage = await measureInjection(memoryInjection);

        await renderStatusOverview('sc_status', 'enabled', overview);
        await renderStatusOverview('sc_easy_status', 'mode', overview);
        await renderBudgetStatus(effectiveSettings, work, memoryUsage);
        await renderMemoryBudget(effectiveSettings, memoryUsage, 'easy_memory');
        renderLayerStats(effectiveSettings, store, ghostedCount);
        await renderPreview(memoryInjection, memoryUsage);
        updateSnippetBrowser();
    } catch (e) {
        warn('updateUI error:', e);
    }
}

/**
 * @param {ReturnType<typeof getSettings>} s
 * @param {ReturnType<typeof getEffectiveSettings>} effectiveSettings
 * @param {import('../core/memory-injection.js').MemoryInjection | null} [injection]
 * @returns {void}
 */
function syncSettingsInputs(s, effectiveSettings, injection = null) {
    syncAllSettingsToDOM(s);
    syncEasyPayloadSchematic(effectiveSettings);
    syncMemoryModeControls(s);
    syncMicroficheBilling(injection, effectiveSettings);
    syncLLMContextPreview(injection, effectiveSettings);
    syncConnectionPanels(s);
}

/**
 * @param {{ off: boolean, easyPanel: boolean, advancedPanel: boolean, continuitySection: boolean, stop: boolean, resume: boolean }} view
 * @returns {void}
 */
export function syncEnabledContent(view) {
    $('#sc_off_content').toggle(view.off);
    $('#sc_easy_content').toggle(view.easyPanel);
    $('#sc_enabled_content').toggle(view.advancedPanel);
    $('#sc_continuity_section').toggle(view.continuitySection);
    $('#sc_stop_summarize, #sc_easy_stop_summarize').toggle(view.stop);
    $('#sc_resume_summarize, #sc_easy_resume_summarize').toggle(view.resume);
}

function syncEasyPayloadSchematic(s = getEffectiveSettings()) {
    $('#sc_easy_payload_memory_budget').text(formatBudgetTokenLabel(s.memoryTokenBudget));
    $('#sc_easy_payload_verbatim_budget').text(formatBudgetTokenLabel(s.verbatimTokenBudget));
    $('#sc_easy_payload_queued_budget').text(formatBudgetTokenLabel(s.queuedTokenBudget));
}

/**
 * Sync the request-context preview lines from the shared core estimator.
 * The caller hands in the built Memory Injection, so the displayed image cost
 * is the cost of the injection that ships, never a re-derived plan.
 * @param {import('../core/memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @param {ReturnType<typeof getEffectiveSettings>} [settings]
 * @returns {void}
 */
export function syncLLMContextPreview(injection = null, settings = getEffectiveSettings()) {
    const model = estimateContextPreview(settings, injection);
    const $mainValue = $('#sc_llm_context_main');
    const $l0Value = $('#sc_llm_context_l0');
    const $l1Value = $('#sc_llm_context_l1');
    $mainValue.text(
        `${formatCompactTokenCount(model.mainMin)} → ${formatCompactTokenCount(model.mainMax)} + ST prompt`,
    );
    $l0Value.text(
        `~${formatCompactTokenCount(model.l0Typical)} (Max ~${formatCompactTokenCount(model.l0Max)})`,
    );
    $l1Value.text(`Max ~${formatCompactTokenCount(model.l1Total)} tokens`);
    setContextValueColor($mainValue, model.mainMax);
    setContextValueColor($l0Value, model.l0Typical);
    setContextValueColor($l1Value, model.l1Total);
}

function setContextValueColor($element, tokens) {
    $element.removeClass(CONTEXT_COLOR_CLASSES).addClass(getContextColorClass(tokens));
}

/**
 * Render the Microfiche holds-and-bills line in the tuning section and the
 * context preview. Both surfaces read the same figures so they cannot drift.
 * @param {import('../core/memory-injection.js').MemoryInjection | null} [injection] - Built Memory Injection, if any.
 * @param {ReturnType<typeof getEffectiveSettings>} [settings]
 * @returns {void}
 */
export function syncMicroficheBilling(injection = null, settings = getEffectiveSettings()) {
    const line = formatMicroficheBillingLine(describeMicroficheBilling(injection, settings));
    $('#sc_microfiche_cost').text(line);
    $('#sc_llm_context_microfiche').text(line);
}

/**
 * @param {{ images: number, heldTokens: number, imageTokens: number, netTokens: number | null, bucketTokens: number, bucketAfterImages: number } | null} billing
 * @returns {string}
 */
function formatMicroficheBillingLine(billing) {
    if (!billing) {
        return 'No images billed.';
    }
    const bucket = `Raw bucket ${formatCompactTokenCount(billing.bucketTokens)}`;
    if (billing.netTokens === null) {
        return (
            `Holds ~${formatCompactTokenCount(billing.heldTokens)} text tokens. ` +
            `Custom geometry has no preset image cost, so billing is unknown. ` +
            `${bucket}: image billing unknown.`
        );
    }
    return (
        `Holds ~${formatCompactTokenCount(billing.heldTokens)} text tokens → ` +
        `bills ~${formatCompactTokenCount(billing.imageTokens)} image tokens, ` +
        `net ${formatCompactTokenCount(billing.netTokens)}. ` +
        `${bucket}: ${formatCompactTokenCount(billing.imageTokens)} to images, ` +
        `${formatCompactTokenCount(billing.bucketAfterImages)} left for text.`
    );
}

async function renderStatusOverview(prefix, modeField, overview) {
    const { settings: s, modeLabel, work, ghostedCount, metrics, busy } = overview;
    $(`#${prefix}_${modeField}`).text(modeLabel);
    $(`#${prefix}_worker`).text(await getWorkerLabel(s, work, busy));
    $(`#${prefix}_snippets`).text(String(metrics.totalSnippets));
    $(`#${prefix}_ghosted`).text(String(ghostedCount));
}

/**
 * @param {ReturnType<typeof getEffectiveSettings>} s
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @param {boolean} busy - Whether any summarizer work is live
 * @returns {Promise<string>}
 */
async function getWorkerLabel(s, work, busy) {
    if (busy) {
        return 'Running';
    }
    if (!s.enabled) {
        return 'Off';
    }

    const backlogCount = work?.ready ? work.backlog : 0;
    return backlogCount > 0 ? `Backlog ${backlogCount}` : 'Idle';
}

const MICROFICHE_GEOMETRY_INPUTS = Object.freeze([
    '#sc_microfiche_font',
    '#sc_microfiche_cell_width',
    '#sc_microfiche_cell_width_val',
    '#sc_microfiche_cell_height',
    '#sc_microfiche_cell_height_val',
    '#sc_microfiche_stretch',
    '#sc_microfiche_variant',
    '#sc_microfiche_stopword_dim',
    '#sc_microfiche_columns',
    '#sc_microfiche_line_repeat',
    '#sc_microfiche_line_repeat_val',
    '#sc_microfiche_frame_size',
    '#sc_microfiche_frame_size_val',
]);
/**
 * Sync panel visibility plus the Microfiche control locks. Named presets stamp
 * the explicit geometry knobs, so those inputs stay disabled until custom unlocks them.
 */
export function syncMemoryModeControls(s) {
    const isPrefixCache = s.memoryMode === MEMORY_MODES.PREFIX_CACHE;
    const isMicrofiche = s.memoryMode === MEMORY_MODES.MICROFICHE;
    const isCustomGeometry = s.microficheGeometry === 'custom';
    const isMacroOnly = s.customMemoryPosition === MEMORY_POSITIONS.MACRO_ONLY;
    $('#sc_custom_memory_depth_row').toggle(s.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT);
    $('#sc_custom_memory_role_row').toggle(!isMacroOnly);
    $('#sc_macro_memory_note').toggle(isMacroOnly);
    $('#sc_memory_help_balanced').toggle(s.memoryMode === MEMORY_MODES.BALANCED);
    $('#sc_memory_help_prefix_cache').toggle(isPrefixCache);
    $('#sc_memory_help_microfiche').toggle(isMicrofiche);
    $('#sc_manual_cache_warning').toggle(isPrefixCache);
    $('.sc-cache-mode-row').toggle(isPrefixCache);
    $('.sc-microfiche-mode-row').toggle(isMicrofiche);
    syncMicroficheGeometryLock(isCustomGeometry);
}

/**
 * Lock the explicit geometry knobs behind the custom selector. Named presets
 * stamp these knobs, so the inputs stay read-only until custom unlocks them.
 * @param {boolean} unlocked - True when the custom geometry is selected.
 * @returns {void}
 */
function syncMicroficheGeometryLock(unlocked) {
    for (const selector of MICROFICHE_GEOMETRY_INPUTS) {
        $(selector).prop('disabled', !unlocked);
    }
}

async function renderBudgetStatus(s, work, memoryUsage) {
    await renderVerbatimBudget(s, work);
    await renderTriggerGauge(s, work);
    await renderMemoryBudget(s, memoryUsage);
}

/**
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

/**
 * @param {ReturnType<typeof getEffectiveSettings>} s
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @returns {Promise<void>}
 */
async function renderVerbatimBudget(s, work) {
    await renderBudgetCard('verbatim', () => {
        if (!work) {
            throw new Error('Summary work read model unavailable');
        }
        return {
            budget: s.verbatimTokenBudget,
            verbatim: {
                label: 'Recent Chat',
                kind: 'verbatim',
                count: work.verbatimTokens,
                estimated: work.verbatimEstimated,
            },
            layers: [],
        };
    });
}

/**
 * @param {ReturnType<typeof getEffectiveSettings>} s
 * @param {import('../core/summarization-routes.js').AutoWorkReadModel | null} work
 * @returns {Promise<void>}
 */
async function renderTriggerGauge(s, work) {
    await renderBudgetCard('trigger', () => {
        if (!work) {
            throw new Error('Summary work read model unavailable');
        }
        const model = buildTriggerGaugeModel(work, s);
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

async function renderMemoryBudget(s, usage, prefix = 'memory') {
    await renderBudgetCard(prefix, () => ({
        budget: s.memoryTokenBudget,
        verbatim: { label: 'Live Chat', kind: 'verbatim', count: 0, estimated: false },
        layers: orderMemoryBudgetParts(usage.parts),
    }));
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

function getBudgetSegmentTitle(segment) {
    return `${segment.label}: ${formatBudgetTokenLabel(segment.count, segment.estimated)} tokens`;
}

/**
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
 * Render the injection preview textarea and the token count of the very same
 * text that was measured for the budget bar.
 * @param {import('../core/memory-injection.js').MemoryInjection} injection
 * @param {import('../core/memory-injection.js').MemoryInjectionUsage} usage
 * @returns {void}
 */
function renderPreview(injection, usage) {
    $('#sc_preview').val(injection.text || '(empty - no summaries yet)');
    $('#sc_preview_token_count').text(
        `${formatBudgetTokenLabel(usage.total.count, usage.total.estimated)} tokens`,
    );
}
