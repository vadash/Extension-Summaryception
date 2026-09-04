import { clampNumericSetting } from '../foundation/numeric.js';
import { SETTINGS_HELP, controlFor } from './settings-help-data.js';

const HELP_EVENT_NS = '.summaryceptionSettingsHelp';
const HELP_TOOLTIP_ID = 'sc_help_tooltip';
const HELP_TARGET_SELECTOR = '.sc-help-target';
const HELP_ICON_SELECTOR = '.sc-help-icon';
const HELP_FOCUS_SELECTOR = [
    '.sc-help-target',
    '.sc-help-target input',
    '.sc-help-target select',
    '.sc-help-target textarea',
    '[data-sc-help-control]',
].join(', ');
const HELP_TOOLTIP_DELAY_MS = 500;

let helpTooltipTimer = null;

/**
 * Annotate the rendered settings DOM and bind the shared help tooltip.
 * @returns {void}
 */
export function initSettingsHelp() {
    const $settings = $('.sc-settings').last();
    if (!$settings.length) {
        return;
    }

    for (const [key, entry] of Object.entries(SETTINGS_HELP)) {
        annotateHelpEntry($settings, key, entry);
    }

    const $tooltip = getHelpTooltip($settings);
    bindHelpTooltip($settings, $tooltip);
}

/**
 * Calculate viewport coordinates for the shared settings help tooltip.
 * @param {object} p
 * @param {{left: number, right: number, top: number, bottom: number}} p.anchorRect
 * @param {{left: number, right: number}} p.settingsRect
 * @param {number} p.tooltipWidth
 * @param {number} p.tooltipHeight
 * @param {number} p.viewportWidth
 * @param {number} p.viewportHeight
 * @returns {{left: number, top: number}}
 */
export function calculateHelpTooltipPosition({
    anchorRect,
    settingsRect,
    tooltipWidth,
    tooltipHeight,
    viewportWidth,
    viewportHeight,
}) {
    const minLeft = Math.max(8, settingsRect.left + 6);
    const maxLeft = Math.max(
        minLeft,
        Math.min(viewportWidth - tooltipWidth - 8, settingsRect.right - tooltipWidth - 6),
    );
    let top = anchorRect.bottom + 6;

    if (top + tooltipHeight > viewportHeight - 8) {
        top = anchorRect.top - tooltipHeight - 6;
    }

    return {
        left: clampNumericSetting(anchorRect.left, {
            fallback: minLeft,
            min: minLeft,
            max: maxLeft,
        }),
        top: clampNumericSetting(top, {
            fallback: 8,
            min: 8,
            max: Math.max(8, viewportHeight - tooltipHeight - 8),
        }),
    };
}

function annotateHelpEntry($settings, key, entry) {
    const $selected = $settings.find(entry.selector).first();
    if (!$selected.length) {
        return;
    }

    const $target = resolveHelpTarget($selected);
    $target.addClass('sc-help-target').attr('data-sc-help-key', key);
    updateShortHint($settings, $target, $selected, entry);
    addHelpIcon($target, $selected);
    addHiddenDescription($settings, key, entry);
    annotateControls({ $settings, $target, $selected, key, entry });
}

function resolveHelpTarget($selected) {
    const rowSelector = ['.sc-row', '.sc-setting-row', '.sc-toggle-row', '.sc-mode-card'].join(
        ', ',
    );

    if ($selected.is(rowSelector)) {
        return $selected;
    }

    const $row = $selected.closest(rowSelector);
    return $row.length ? $row : $selected;
}

function updateShortHint($settings, $target, $selected, entry) {
    const $hintHost = getHintHost($target, $selected);
    if ($hintHost.length) {
        const $hint = getOrCreateHint($hintHost);
        $hint.text(entry.short);
        $hintHost.children('.sc-hint').not($hint).remove();
        return;
    }

    const $rowHint = getOrCreateRowHint($settings, $target);
    $rowHint.text(entry.short);
}

function getHintHost($target, $selected) {
    const $copy = $target.find('.sc-toggle-copy').first();
    if ($copy.length) {
        return $copy;
    }
    if ($selected.is('label')) {
        return $selected;
    }
    const $label = $target.find('label').first();
    return $label.length ? $label : $();
}

function getOrCreateHint($hintHost) {
    const $existing = $hintHost.children('.sc-hint, small').first();
    if ($existing.length) {
        return $existing.addClass('sc-hint');
    }
    return $('<small class="sc-hint"></small>').appendTo($hintHost);
}

function getOrCreateRowHint($settings, $target) {
    const key = String($target.attr('data-sc-help-key') || '');
    const selector = `.sc-hint.sc-help-row-hint[data-sc-help-key="${key}"]`;
    const $existing = $settings.find(selector).first();
    if ($existing.length) {
        return $existing;
    }
    return $('<small class="sc-hint sc-help-row-hint"></small>')
        .attr('data-sc-help-key', key)
        .insertAfter($target);
}

function addHelpIcon($target, $selected) {
    if ($target.find('.sc-help-icon').length) {
        return;
    }

    const $title = getTitleTarget($target, $selected);
    const $icon = $('<span class="sc-help-icon fa-solid fa-circle-question"></span>').attr(
        'aria-hidden',
        'true',
    );

    if ($title.length) {
        $icon.insertAfter($title);
        return;
    }
    $icon.insertAfter($selected);
}

function getTitleTarget($target, $selected) {
    const $title = $target.find('.sc-toggle-title').first();
    if ($title.length) {
        return $title;
    }
    if ($selected.is('label')) {
        return $selected.children('span').first();
    }
    const $labelTitle = $target.find('label > span').first();
    return $labelTitle.length ? $labelTitle : $();
}

function addHiddenDescription($settings, key, entry) {
    const id = getDescriptionId(key);
    const $existing = $settings.find(`#${id}`).first();
    const text = `${entry.title}. ${entry.detail}`;
    if ($existing.length) {
        $existing.text(text);
        return;
    }
    $('<span class="sc-sr-only"></span>').attr('id', id).text(text).appendTo($settings);
}

function annotateControls({ $settings, $target, $selected, key, entry }) {
    const controls = getControlSelectors($target, $selected, entry);
    const descId = getDescriptionId(key);

    for (const selector of controls) {
        $settings.find(selector).each(function () {
            const $control = $(this);
            addDescribedBy($control, descId);
            $control.attr('data-sc-help-control', key);
        });
    }
}

function getControlSelectors($target, $selected, entry) {
    if (entry.controls?.length) {
        return entry.controls;
    }
    if ($selected.is('label[for]')) {
        return [controlFor($selected.attr('for'))];
    }

    const $label = $target.find('label[for]').first();
    if ($label.length) {
        return [controlFor($label.attr('for'))];
    }
    return [];
}

function addDescribedBy($control, descId) {
    const existing = String($control.attr('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean);
    if (!existing.includes(descId)) {
        existing.push(descId);
    }
    $control.attr('aria-describedby', existing.join(' '));
}

function getDescriptionId(key) {
    return `sc_help_desc_${String(key).replaceAll(/[^a-z0-9_-]/gi, '_')}`;
}

function getHelpTooltip($settings) {
    $settings.children('.sc-help-tooltip').remove();

    let $tooltip = $(`#${HELP_TOOLTIP_ID}`).first();
    if ($tooltip.length) {
        return $tooltip.empty();
    }

    $tooltip = $('<div class="sc-help-tooltip" role="tooltip"></div>').attr('aria-hidden', 'true');
    $tooltip.attr('id', HELP_TOOLTIP_ID).appendTo('body');
    return $tooltip;
}

function bindHelpTooltip($settings, $tooltip) {
    $settings.off(HELP_EVENT_NS);
    $(document).off(HELP_EVENT_NS);
    $(window).off(HELP_EVENT_NS);
    clearTooltipTimer();

    const hide = () => {
        clearTooltipTimer();
        hideTooltip($tooltip);
    };

    $settings.on(`mouseenter${HELP_EVENT_NS}`, HELP_ICON_SELECTOR, function () {
        clearTooltipTimer();
        const icon = this;
        helpTooltipTimer = setTimeout(() => {
            helpTooltipTimer = null;
            const $target = getHelpTarget($(icon));
            showTooltip($settings, $tooltip, $target, icon);
        }, HELP_TOOLTIP_DELAY_MS);
    });
    $settings.on(`mouseleave${HELP_EVENT_NS}`, HELP_ICON_SELECTOR, hide);
    $settings.on(`focusout${HELP_EVENT_NS}`, HELP_FOCUS_SELECTOR, hide);
    $settings.on(`click${HELP_EVENT_NS}`, '.sc-tab-button, .sc-prompt-segment-button', hide);
    $settings.on(`scroll${HELP_EVENT_NS}`, hide);
    $(window).on(`scroll${HELP_EVENT_NS} resize${HELP_EVENT_NS}`, hide);
    $(document).on(`keydown${HELP_EVENT_NS}`, (event) => {
        if (event.key === 'Escape') {
            hide();
        }
    });
}

function clearTooltipTimer() {
    if (helpTooltipTimer !== null) {
        clearTimeout(helpTooltipTimer);
        helpTooltipTimer = null;
    }
}

function getHelpTarget($element) {
    if ($element.is(HELP_TARGET_SELECTOR)) {
        return $element;
    }
    const $target = $element.closest(HELP_TARGET_SELECTOR);
    return $target.length ? $target : $element;
}

function showTooltip($settings, $tooltip, $target, anchor) {
    const key = String(
        $target.attr('data-sc-help-key') || $target.attr('data-sc-help-control') || '',
    );
    const entry = SETTINGS_HELP[key];
    if (!entry) {
        return;
    }

    $tooltip
        .empty()
        .append($('<div class="sc-help-tooltip-title"></div>').text(entry.title))
        .append($('<div class="sc-help-tooltip-body"></div>').text(entry.detail))
        .attr('aria-hidden', 'false')
        .css({ display: 'block', visibility: 'hidden' });

    positionTooltip($settings, $tooltip, anchor);
    $tooltip.css('visibility', 'visible');
}

function hideTooltip($tooltip) {
    $tooltip.attr('aria-hidden', 'true').hide();
}

function positionTooltip($settings, $tooltip, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const settingsRect = $settings[0].getBoundingClientRect();
    const tooltipWidth = $tooltip.outerWidth() || 280;
    const tooltipHeight = $tooltip.outerHeight() || 80;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 480;
    const position = calculateHelpTooltipPosition({
        anchorRect,
        settingsRect,
        tooltipWidth,
        tooltipHeight,
        viewportWidth,
        viewportHeight,
    });

    $tooltip.css({
        left: `${position.left}px`,
        top: `${position.top}px`,
    });
}
