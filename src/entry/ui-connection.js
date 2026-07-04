import { getRequestHeaders } from '../foundation/context.js';
import {
    fetchOllamaModels,
    testSummarizerConnection,
    populateProfileDropdown,
} from '../core/connectionutil.js';
import { getSettings, saveSettings } from '../foundation/state.js';

// Connection settings UI - jQuery-based DOM access consistent with the rest of the UI layer.

/**
 * Initialize connection settings panel: bind inputs/selects and set initial visibility.
 * @returns {void}
 */
export function initConnectionUI() {
    const settings = getSettings();

    bindConnectionSource(settings);
    bindConnectionProfile(settings);
    bindConnectionStringInput('summaryception_ollama_url', 'ollamaUrl', 'http://localhost:11434');
    bindOllamaModelDropdown(settings);
    bindConnectionButton('summaryception_ollama_refresh', refreshOllamaModels);
    bindConnectionStringInput('summaryception_openai_url', 'openaiUrl', '');
    bindConnectionStringInput('summaryception_openai_key', 'openaiKey', '');
    bindConnectionStringInput('summaryception_openai_model', 'openaiModel', '');
    bindConnectionParsedInput('summaryception_openai_max_tokens', 'openaiMaxTokens', 0);
    bindConnectionButton('summaryception_openai_test', testOpenAIConnectionHandler);

    updateConnectionSubPanels(settings.connectionSource || 'default');
}

/**
 * Bind the connection source dropdown.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindConnectionSource(settings) {
    const $sourceSelect = $('#summaryception_connection_source');
    if (!$sourceSelect.length) {
        return;
    }
    $sourceSelect.val(settings.connectionSource || 'default');
    $sourceSelect.on('change', () => {
        settings.connectionSource = $sourceSelect.val();
        saveSettings();
        updateConnectionSubPanels($sourceSelect.val());
    });
}

/**
 * Bind the connection profile dropdown with fallback population.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindConnectionProfile(settings) {
    const $profileSelect = $('#summaryception_connection_profile');
    if (!$profileSelect.length) {
        return;
    }
    const populated = populateProfileDropdown($profileSelect[0], settings.connectionProfileId);
    if (!populated) {
        fetchProfilesFallback($profileSelect, settings.connectionProfileId);
    }
    $profileSelect.on('change', () => {
        settings.connectionProfileId = $profileSelect.val();
        saveSettings();
    });
}

/**
 * Bind an `<input>` element to a string settings key.
 * @param {string} elementId
 * @param {'ollamaUrl' | 'openaiUrl' | 'openaiKey' | 'openaiModel'} key
 * @param {string} [fallback]
 * @returns {void}
 */
function bindConnectionStringInput(elementId, key, fallback) {
    const $el = $('#' + elementId);
    if (!$el.length) {
        return;
    }
    const settings = getSettings();
    $el.val(settings[key] || fallback);
    $el.on('input', () => {
        settings[key] = ($el.val() || '').trim();
        saveSettings();
    });
}

/**
 * Bind a numeric `<input>` element to a number settings key.
 * @param {string} elementId
 * @param {'openaiMaxTokens'} key
 * @param {number} [fallback]
 * @returns {void}
 */
function bindConnectionParsedInput(elementId, key, fallback) {
    const $el = $('#' + elementId);
    if (!$el.length) {
        return;
    }
    const settings = getSettings();
    $el.val(String(settings[key] || fallback));
    $el.on('input', () => {
        settings[key] = parseInt($el.val(), 10) || 0;
        saveSettings();
    });
}

/**
 * Populate the Ollama model dropdown and bind its change handler.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindOllamaModelDropdown(settings) {
    const $ollamaModel = $('#summaryception_ollama_model');
    if (!$ollamaModel.length) {
        return;
    }
    populateOllamaModelDropdown(
        $ollamaModel,
        settings.ollamaModelsCache || [],
        settings.ollamaModel,
    );
    $ollamaModel.on('change', () => {
        settings.ollamaModel = $ollamaModel.val();
        saveSettings();
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
    const $profile = $('#summaryception_profile_settings');
    const $ollama = $('#summaryception_ollama_settings');
    const $openai = $('#summaryception_openai_settings');

    $profile.add($ollama).add($openai).hide();
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

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map((m) => ({ name: m.name }));
        saveSettings();

        if ($modelSelect.length) {
            populateOllamaModelDropdown($modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
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
            console.warn('[Summaryception] Could not fetch connection profiles from API');
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
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}
