import { getRequestHeaders } from '../foundation/context.js';
import { error as logError, warn } from '../foundation/logger.js';
import {
    fetchOllamaModels,
    testSummarizerConnection,
    populateProfileDropdown,
} from '../core/connectionutil.js';
import { getSettings, saveSettings } from '../foundation/state.js';
import { bindDataSettingElements, bindElementSetting, readString } from './ui-bind.js';

// Connection settings UI - jQuery-based DOM access consistent with the rest of the UI layer.

const CONNECTION_DATA_SETTING_SELECTOR = '#summaryception_connection_settings [data-sc-setting]';

const CONNECTION_ROUTE_BINDINGS = Object.freeze([
    {
        sourceId: 'sc_easy_connection_source',
        sourceKey: 'easyConnectionSource',
        sourceFallback: 'default',
        profileId: 'sc_easy_connection_profile',
        profileKey: 'easyConnectionProfileId',
        updatePanels: updateEasyConnectionSubPanels,
    },
    {
        sourceId: 'sc_easy_merge_connection_source',
        sourceKey: 'easyMergeConnectionSource',
        sourceFallback: 'inherit',
        profileId: 'sc_easy_merge_connection_profile',
        profileKey: 'easyMergeConnectionProfileId',
        updatePanels: updateEasyMergeConnectionSubPanels,
    },
    {
        sourceId: 'summaryception_connection_source',
        sourceKey: 'connectionSource',
        sourceFallback: 'default',
        profileId: 'summaryception_connection_profile',
        profileKey: 'connectionProfileId',
        updatePanels: updateConnectionSubPanels,
    },
    {
        sourceId: 'summaryception_merge_connection_source',
        sourceKey: 'mergeConnectionSource',
        sourceFallback: 'inherit',
        profileId: 'summaryception_merge_connection_profile',
        profileKey: 'mergeConnectionProfileId',
        updatePanels: updateMergeConnectionSubPanels,
    },
    {
        sourceId: 'summaryception_fallback_connection_source',
        sourceKey: 'fallbackConnectionSource',
        sourceFallback: 'disabled',
        profileId: 'summaryception_fallback_connection_profile',
        profileKey: 'fallbackConnectionProfileId',
        updatePanels: updateFallbackConnectionSubPanels,
    },
]);

const OLLAMA_MODEL_DROPDOWNS = Object.freeze([
    { elementId: 'summaryception_ollama_model', key: 'ollamaModel' },
    { elementId: 'summaryception_merge_ollama_model', key: 'mergeOllamaModel' },
    { elementId: 'summaryception_fallback_ollama_model', key: 'fallbackOllamaModel' },
]);

/**
 * Initialize connection settings panel: bind inputs/selects and set initial visibility.
 * @returns {void}
 */
export function initConnectionUI() {
    const settings = getSettings();

    bindConnectionRoutes(settings);
    bindConnectionInputs();
    bindOllamaModelDropdowns(settings);
    bindConnectionButton('summaryception_ollama_refresh', refreshOllamaModels);
    bindConnectionButton('summaryception_openai_test', testOpenAIConnectionHandler);
    bindConnectionButton('summaryception_merge_ollama_refresh', refreshOllamaModels);
    bindConnectionButton('summaryception_fallback_ollama_refresh', refreshOllamaModels);

    updateEasyConnectionSubPanels(settings.easyConnectionSource || 'default');
    updateEasyMergeConnectionSubPanels(settings.easyMergeConnectionSource || 'inherit');
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
        afterSave: (_settings, value) => binding.updatePanels(String(value)),
    });
}

function bindConnectionProfile(settings, binding) {
    const $profileSelect = $('#' + binding.profileId);
    if (!$profileSelect.length) {
        return;
    }
    const populated = populateProfileDropdown($profileSelect[0], settings[binding.profileKey]);
    if (!populated) {
        fetchProfilesFallback($profileSelect, settings[binding.profileKey]);
    }
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

function bindOllamaModelDropdowns(settings) {
    for (const binding of OLLAMA_MODEL_DROPDOWNS) {
        bindOllamaModelDropdown(settings, binding);
    }
}

/**
 * Populate the Ollama model dropdown and bind its change handler.
 * @param {ReturnType<typeof getSettings>} settings
 * @param {{ elementId: string, key: string }} binding
 * @returns {void}
 */
function bindOllamaModelDropdown(settings, { elementId, key }) {
    const $ollamaModel = $('#' + elementId);
    if (!$ollamaModel.length) {
        return;
    }
    populateOllamaModelDropdown($ollamaModel, settings.ollamaModelsCache || [], settings[key]);
    bindElementSetting($ollamaModel, {
        eventName: 'change',
        key,
        read: readString,
    });
}

/**
 * Bind a button click to an async handler.
 * @param {string} elementId
 * @param {() => Promise<void>} handler
 * @returns {void}
 */
function bindConnectionButton(elementId, handler) {
    const $el = $('#' + elementId);
    if (!$el.length) {
        return;
    }
    $el.on('click', async () => {
        await handler();
    });
}

/**
 * Show or hide connection sub-panels (profile/ollama/openai) based on source.
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
    const $ollama = $(`#summaryception${prefix}_ollama_settings`);
    const $openai = $(`#summaryception${prefix}_openai_settings`);

    $profile.add($ollama).add($openai).hide();
    if (toggleResponseLength) {
        $(`#summaryception${prefix}_response_length_row`).toggle(
            source === 'default' || source === 'profile',
        );
    }

    if (source === 'profile') {
        $profile.show();
    } else if (source === 'ollama') {
        $ollama.show();
    } else if (source === 'openai') {
        $openai.show();
    }
}

/**
 * Populate an Ollama model dropdown.
 * @param {object} $select jQuery-wrapped <select> element
 * @param {Array<({ name: string } | string)>} models
 * @param {string} currentValue
 * @returns {void}
 */
export function populateOllamaModelDropdown($select, models, currentValue) {
    $select.html('<option value="">-- Select Model --</option>');

    if (models && models.length > 0) {
        for (const model of models) {
            const name = typeof model === 'string' ? model : model.name;
            $select.append($('<option></option>').val(name).text(name));
        }
    }

    if (currentValue) {
        $select.val(currentValue);
    }
}

/**
 * Fetch available Ollama models from the configured URL and refresh the dropdown.
 * @returns {Promise<void>}
 */
export async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const $modelSelect = $('#summaryception_ollama_model');
    const $mergeModelSelect = $('#summaryception_merge_ollama_model');
    const $fallbackModelSelect = $('#summaryception_fallback_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map((m) => ({ name: m.name }));
        saveSettings();

        if ($modelSelect.length) {
            populateOllamaModelDropdown($modelSelect, models, s.ollamaModel);
        }
        if ($mergeModelSelect.length) {
            populateOllamaModelDropdown($mergeModelSelect, models, s.mergeOllamaModel);
        }
        if ($fallbackModelSelect.length) {
            populateOllamaModelDropdown($fallbackModelSelect, models, s.fallbackOllamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        logError('Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

/**
 * Test the OpenAI-compatible connection using current settings.
 * @returns {Promise<void>}
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

    const result = await testSummarizerConnection({ ...s, connectionSource: 'openai' });

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

/**
 * Show connection status indicator with auto-hide for non-loading states.
 * @param {string} type
 * @param {string} message
 * @returns {void}
 */
export function showConnectionStatus(type, message) {
    const $container = $('#summaryception_connection_status');
    const $icon = $('#summaryception_connection_status_icon');
    const $text = $('#summaryception_connection_status_text');

    if (!$container.length || !$icon.length || !$text.length) {
        return;
    }

    $container.css('display', 'flex').attr('class', 'sc-connection-status ' + type);

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    $icon.attr(
        'class',
        /** @type {Record<string, string>} */ (icons)[type] || 'fa-solid fa-circle',
    );
    $text.text(message);

    if (type !== 'loading') {
        setTimeout(() => {
            if ($container.length) {
                $container.hide();
            }
        }, 8000);
    }
}

/**
 * Fallback fetch for connection profiles from ST connection-manager API.
 * @param {object} $select jQuery-wrapped <select> element to populate
 * @param {string} currentValue
 * @returns {Promise<void>}
 */
export async function fetchProfilesFallback($select, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            warn('Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        $select.html('<option value="">-- Select a Profile --</option>');

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                $select.append(
                    $('<option></option>')
                        .val(profile.id || profile.name)
                        .text(profile.name || profile.id),
                );
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                $select.append(
                    $('<option></option>')
                        .val(id)
                        .text(profile.name || id),
                );
            }
        }

        if (currentValue) {
            $select.val(currentValue);
        }
    } catch (error) {
        warn('Could not fetch connection profiles:', error);
    }
}
