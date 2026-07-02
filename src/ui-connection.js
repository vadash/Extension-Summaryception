import {
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
} from './connectionutil.js';
import { getSettings, saveSettings } from './state.js';

// ─── Connection Settings UI ──────────────────────────────────────────

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
    const sourceSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_connection_source')
    );
    if (!sourceSelect) {
        return;
    }
    sourceSelect.value = settings.connectionSource || 'default';
    sourceSelect.addEventListener('change', () => {
        settings.connectionSource = sourceSelect.value;
        saveSettings();
        updateConnectionSubPanels(sourceSelect.value);
    });
}

/**
 * Bind the connection profile dropdown with fallback population.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindConnectionProfile(settings) {
    const profileSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_connection_profile')
    );
    if (!profileSelect) {
        return;
    }
    const populated = populateProfileDropdown(profileSelect, settings.connectionProfileId);
    if (!populated) {
        fetchProfilesFallback(profileSelect, settings.connectionProfileId);
    }
    profileSelect.addEventListener('change', () => {
        settings.connectionProfileId = profileSelect.value;
        saveSettings();
    });
}

/**
 * Bind an `<input>` element to a string settings key.
 * @param {string} elementId
 * @param {string} key
 * @param {string} [fallback]
 * @returns {void}
 */
function bindConnectionStringInput(elementId, key, fallback) {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(elementId));
    if (!el) {
        return;
    }
    const settings = getSettings();
    el.value = settings[key] || fallback;
    el.addEventListener('input', () => {
        settings[key] = el.value.trim();
        saveSettings();
    });
}

/**
 * Bind a numeric `<input>` element to a number settings key.
 * @param {string} elementId
 * @param {string} key
 * @param {number} [fallback]
 * @returns {void}
 */
function bindConnectionParsedInput(elementId, key, fallback) {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(elementId));
    if (!el) {
        return;
    }
    const settings = getSettings();
    el.value = String(settings[key] || fallback);
    el.addEventListener('input', () => {
        settings[key] = parseInt(el.value, 10) || 0;
        saveSettings();
    });
}

/**
 * Populate the Ollama model dropdown and bind its change handler.
 * @param {ReturnType<typeof getSettings>} settings
 * @returns {void}
 */
function bindOllamaModelDropdown(settings) {
    const ollamaModel = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_ollama_model')
    );
    if (!ollamaModel) {
        return;
    }
    populateOllamaModelDropdown(
        ollamaModel,
        settings.ollamaModelsCache || [],
        settings.ollamaModel,
    );
    ollamaModel.addEventListener('change', () => {
        settings.ollamaModel = ollamaModel.value;
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
    const el = /** @type {HTMLButtonElement} */ (document.getElementById(elementId));
    if (!el) {
        return;
    }
    el.addEventListener('click', async () => {
        await handler();
    });
}

/**
 * Show or hide connection sub-panels (profile/ollama/openai) based on source.
 * @param {string} source
 * @returns {void}
 */
export function updateConnectionSubPanels(source) {
    const panels = {
        profile: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_profile_settings')
        ),
        ollama: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_ollama_settings')
        ),
        openai: /** @type {HTMLElement} */ (
            document.getElementById('summaryception_openai_settings')
        ),
    };

    Object.values(panels).forEach((panel) => {
        if (panel) {
            panel.style.display = 'none';
        }
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

/**
 * Populate an Ollama model dropdown.
 * @param {HTMLSelectElement} selectElement
 * @param {Array<({ name: string } | string)>} models
 * @param {string} currentValue
 * @returns {void}
 */
export function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            const name = typeof model === 'string' ? model : model.name;
            opt.value = name;
            opt.textContent = name;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

/**
 * Fetch available Ollama models from the configured URL and refresh the dropdown.
 * @returns {Promise<void>}
 */
export async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = /** @type {HTMLSelectElement} */ (
        document.getElementById('summaryception_ollama_model')
    );

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map((m) => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
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

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

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
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) {
        return;
    }

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) {
                container.style.display = 'none';
            }
        }, 8000);
    }
}

/**
 * Fallback fetch for connection profiles from ST connection-manager API.
 * @param {HTMLSelectElement} selectElement
 * @param {string} currentValue
 * @returns {Promise<void>}
 */
export async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}
