import { populateProfileDropdown } from '../core/connectionutil.js';
import { getSettings } from '../foundation/state.js';
import { bindDataSettingElements, bindElementSetting, readString } from './ui-bind.js';
import { refreshEffectiveSettings } from './ui-events.js';

// Connection settings UI - jQuery-based DOM access consistent with the rest of the UI layer.

const CONNECTION_DATA_SETTING_SELECTOR = [
    '#sc_summarizer_response_length',
    '#sc_merge_summarizer_response_length',
    '#sc_fallback_summarizer_response_length',
].join(', ');

const CONNECTION_ROUTE_BINDINGS = Object.freeze([
    {
        sourceId: 'sc_easy_connection_source',
        sourceKey: 'connectionSource',
        sourceFallback: 'default',
        profileId: 'sc_easy_connection_profile',
        profileKey: 'connectionProfileId',
    },
    {
        sourceId: 'sc_easy_merge_connection_source',
        sourceKey: 'mergeConnectionSource',
        sourceFallback: 'inherit',
        profileId: 'sc_easy_merge_connection_profile',
        profileKey: 'mergeConnectionProfileId',
    },
    {
        sourceId: 'summaryception_connection_source',
        sourceKey: 'connectionSource',
        sourceFallback: 'default',
        profileId: 'summaryception_connection_profile',
        profileKey: 'connectionProfileId',
    },
    {
        sourceId: 'summaryception_merge_connection_source',
        sourceKey: 'mergeConnectionSource',
        sourceFallback: 'inherit',
        profileId: 'summaryception_merge_connection_profile',
        profileKey: 'mergeConnectionProfileId',
    },
    {
        sourceId: 'summaryception_fallback_connection_source',
        sourceKey: 'fallbackConnectionSource',
        sourceFallback: 'disabled',
        profileId: 'summaryception_fallback_connection_profile',
        profileKey: 'fallbackConnectionProfileId',
    },
]);

/**
 * Initialize connection settings panel: bind inputs/selects and set initial visibility.
 * @returns {void}
 */
export function initConnectionUI() {
    const settings = getSettings();

    bindConnectionRoutes(settings);
    bindConnectionInputs();

    updateEasyConnectionSubPanels(settings.connectionSource || 'default');
    updateEasyMergeConnectionSubPanels(settings.mergeConnectionSource || 'inherit');
    updateConnectionSubPanels(settings.connectionSource || 'default');
    updateMergeConnectionSubPanels(settings.mergeConnectionSource || 'inherit');
    updateFallbackConnectionSubPanels(settings.fallbackConnectionSource || 'disabled');
}

function bindConnectionRoutes(settings) {
    for (const binding of CONNECTION_ROUTE_BINDINGS) {
        bindConnectionSource(settings, binding);
        bindConnectionProfile(settings, binding);
    }
}

function bindConnectionSource(settings, binding) {
    const $sourceSelect = $('#' + binding.sourceId);
    if (!$sourceSelect.length) {
        return;
    }
    $sourceSelect.val(settings[binding.sourceKey] || binding.sourceFallback);
    bindElementSetting($sourceSelect, {
        eventName: 'change',
        key: binding.sourceKey,
        read: readString,
        afterSave: refreshEffectiveSettings,
    });
}

function bindConnectionProfile(settings, binding) {
    const $profileSelect = $('#' + binding.profileId);
    if (!$profileSelect.length) {
        return;
    }
    populateProfileDropdown($profileSelect[0], settings[binding.profileKey]);
    bindElementSetting($profileSelect, {
        eventName: 'change',
        key: binding.profileKey,
        read: readString,
    });
}

function bindConnectionInputs() {
    bindDataSettingElements(CONNECTION_DATA_SETTING_SELECTOR, {
        eventName: 'input',
        beforeSave: syncMatchingConnectionInputs,
    });
}

/**
 * Keep duplicate controls with the same saved connection setting visually in sync.
 * @param {ReturnType<typeof getSettings>} _settings
 * @param {unknown} value
 * @param {object} $source
 * @returns {void}
 */
function syncMatchingConnectionInputs(_settings, value, $source) {
    const key = String($source.attr('data-sc-setting') ?? '');
    if (!key) {
        return;
    }
    const sourceElement = $source[0];
    $(CONNECTION_DATA_SETTING_SELECTOR).each(function () {
        if (this === sourceElement) {
            return;
        }
        const $element = $(this);
        if ($element.attr('data-sc-setting') === key) {
            $element.val(String(value));
        }
    });
}

/**
 * Show or hide connection sub-panels based on source.
 * @param {string} source
 * @returns {void}
 */
export function updateConnectionSubPanels(source) {
    toggleRouteSubPanels('', source);
}

/**
 *
 */
export function updateEasyConnectionSubPanels(source) {
    $('#sc_easy_profile_settings').toggle(source === 'profile');
}

/**
 *
 */
export function updateEasyMergeConnectionSubPanels(source) {
    $('#sc_easy_merge_profile_settings').toggle(source === 'profile');
}

/**
 * Show or hide Layer 1+ merge connection sub-panels based on source.
 * @param {string} source
 * @returns {void}
 */
export function updateMergeConnectionSubPanels(source) {
    toggleRouteSubPanels('_merge', source, { toggleResponseLength: true });
}

/**
 * Show or hide fallback connection sub-panels based on source.
 * @param {string} source
 * @returns {void}
 */
export function updateFallbackConnectionSubPanels(source) {
    toggleRouteSubPanels('_fallback', source, { toggleResponseLength: true });
}

/**
 * Show or hide connection sub-panels for one route.
 * @param {'' | '_merge' | '_fallback'} prefix
 * @param {string} source
 * @param {{ toggleResponseLength?: boolean }} [options]
 * @returns {void}
 */
function toggleRouteSubPanels(prefix, source, { toggleResponseLength = false } = {}) {
    const $profile = $(`#summaryception${prefix}_profile_settings`);
    $profile.hide();
    if (toggleResponseLength) {
        $(`#summaryception${prefix}_response_length_row`).toggle(
            source === 'default' || source === 'profile',
        );
    }

    if (source === 'profile') {
        $profile.show();
    }
}
