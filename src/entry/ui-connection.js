import { populateProfileDropdown } from '../core/connectionutil.js';
import { refreshFull } from '../foundation/refresh.js';
import { getSettings } from '../foundation/state.js';
import { bindDataSettingElements, bindElementSetting, readString } from './ui-bind.js';

const CONNECTION_DATA_SETTING_SELECTOR = [
    '#sc_summarizer_response_length',
    '#sc_merge_summarizer_response_length',
    '#sc_fallback_summarizer_response_length',
    '#sc_auditor_summarizer_response_length',
    '#sc_auditor_fallback_summarizer_response_length',
    '#sc_auditor_narrative_fallback',
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
    {
        sourceId: 'summaryception_auditor_connection_source',
        sourceKey: 'auditorConnectionSource',
        sourceFallback: 'inherit',
        profileId: 'summaryception_auditor_connection_profile',
        profileKey: 'auditorConnectionProfileId',
    },
    {
        sourceId: 'summaryception_auditor_fallback_connection_source',
        sourceKey: 'auditorFallbackConnectionSource',
        sourceFallback: 'disabled',
        profileId: 'summaryception_auditor_fallback_connection_profile',
        profileKey: 'auditorFallbackConnectionProfileId',
    },
]);

/**
 * @returns {void}
 */
export function initConnectionUI() {
    const settings = getSettings();

    bindConnectionRoutes(settings);
    bindConnectionInputs();
    syncConnectionPanels(settings);
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
        afterSave: refreshFull,
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
    });
}

/**
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
 * @param {string} source
 * @returns {void}
 */
export function updateMergeConnectionSubPanels(source) {
    toggleRouteSubPanels('_merge', source, { toggleResponseLength: true });
}

/**
 * @param {string} source
 * @returns {void}
 */
export function updateFallbackConnectionSubPanels(source) {
    toggleRouteSubPanels('_fallback', source, { toggleResponseLength: true });
}

/**
 * The Auditor primary route only exists when separated from Layer 0, so
 * 'inherit' also hides the Auditor fallback card and the narrative failover
 * checkbox.
 * @param {string} source
 * @returns {void}
 */
export function updateAuditorConnectionSubPanels(source) {
    const separated = toggleRouteSubPanels('_auditor', source, { toggleResponseLength: true });
    $('#summaryception_auditor_fallback_section').toggle(separated);
    $('#sc_auditor_narrative_fallback_row').toggle(separated);
}

/**
 * @param {string} source
 * @returns {void}
 */
export function updateAuditorFallbackConnectionSubPanels(source) {
    toggleRouteSubPanels('_auditor_fallback', source, { toggleResponseLength: true });
}

/**
 * @param {'' | '_merge' | '_fallback' | '_auditor' | '_auditor_fallback'} prefix
 * @param {string} source
 * @param {{ toggleResponseLength?: boolean }} [options]
 * @returns {boolean} True when the source names a separated route (default/profile).
 */
function toggleRouteSubPanels(prefix, source, { toggleResponseLength = false } = {}) {
    const $profile = $(`#summaryception${prefix}_profile_settings`);
    $profile.hide();
    const routeActive = source === 'default' || source === 'profile';
    if (toggleResponseLength) {
        $(`#summaryception${prefix}_response_length_row`).toggle(routeActive);
        $(`#summaryception${prefix}_timeout_row`).toggle(routeActive);
    }

    if (source === 'profile') {
        $profile.show();
    }
    return routeActive;
}

/**
 * @param {ReturnType<typeof getSettings>} s
 * @returns {void}
 */
export function syncConnectionPanels(s) {
    updateEasyConnectionSubPanels(s.connectionSource || 'default');
    updateEasyMergeConnectionSubPanels(s.mergeConnectionSource || 'inherit');
    updateConnectionSubPanels(s.connectionSource || 'default');
    updateMergeConnectionSubPanels(s.mergeConnectionSource || 'inherit');
    updateFallbackConnectionSubPanels(s.fallbackConnectionSource || 'disabled');
    updateAuditorConnectionSubPanels(s.auditorConnectionSource || 'inherit');
    updateAuditorFallbackConnectionSubPanels(s.auditorFallbackConnectionSource || 'disabled');
}
