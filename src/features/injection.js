import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
} from '../foundation/constants.js';
import { setExtensionPrompt } from '../foundation/context.js';
import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { debug, isDebugEnabled, warn } from '../foundation/logger.js';
import { buildEffectiveMemoryText } from '../core/memory-budget.js';
import { isPromptMutationFrozen } from '../core/summarizer-commit.js';
import { countTextTokens, formatTokenCount } from '../core/token-count.js';

// ─── Core: Assemble Full Summary Block ──────────────────────────────

/**
 * Build the summary block by combining all layer snippets.
 * @returns {string} The assembled summary block, or '' if no snippets exist
 */
export function assembleSummaryBlock() {
    const s = getEffectiveSettings();
    const store = getChatStore();
    return buildEffectiveMemoryText(store.layers, s);
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjectionKey = '';
let _activeInjectionSnapshot = null;
let _activeInjectionOptions = null;

/**
 * Update the committed memory injection.
 * @param {{ logMemoryStatus?: boolean }} [options] - Diagnostic logging options
 * @returns {void}
 */
export function updateInjection({ logMemoryStatus = false } = {}) {
    try {
        if (isPromptMutationFrozen()) {
            return;
        }

        const store = getChatStore();
        const nextInjection = buildEnabledInjectionText();
        const nextOptions = getMemoryInjectionOptions();
        _activeInjectionSnapshot = nextInjection;
        _activeInjectionOptions = nextOptions;

        const nextKey = getInjectionKey(nextInjection, nextOptions);
        if (nextKey === _lastInjectionKey) {
            return;
        }

        setExtensionPrompt(MODULE_NAME, nextInjection, nextOptions);
        _lastInjectionKey = nextKey;

        if (logMemoryStatus) {
            queueMemoryStatusLog(nextInjection, store.layers);
        }
    } catch (e) {
        warn('updateInjection error:', e);
    }
}

/**
 * Reapply the last committed injection snapshot without reading pending changes.
 * @returns {void}
 */
export function reassertInjectionSnapshot() {
    try {
        if (_activeInjectionSnapshot === null) {
            _activeInjectionSnapshot = buildEnabledInjectionText();
        }
        if (_activeInjectionOptions === null) {
            _activeInjectionOptions = getMemoryInjectionOptions();
        }

        setExtensionPrompt(MODULE_NAME, _activeInjectionSnapshot, _activeInjectionOptions);
        _lastInjectionKey = getInjectionKey(_activeInjectionSnapshot, _activeInjectionOptions);
    } catch (e) {
        warn('reassertInjectionSnapshot error:', e);
    }
}

/**
 * Resolve SillyTavern extension prompt options from the configured memory mode.
 * @param {ExtensionSettings} [settings]
 * @returns {{ position: number, depth: number, scan: boolean, role: number }}
 */
export function getMemoryInjectionOptions(settings = getEffectiveSettings()) {
    if (settings.memoryMode !== MEMORY_MODES.CUSTOM) {
        return getStandardInjectionOptions();
    }

    return {
        position: mapMemoryPosition(settings.customMemoryPosition),
        depth:
            settings.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT
                ? settings.customMemoryDepth
                : 0,
        scan: false,
        role: mapMemoryRole(settings.customMemoryRole),
    };
}

/**
 * Build the prompt text that should be committed for the current store/settings.
 * @returns {string}
 */
function buildEnabledInjectionText() {
    const s = getEffectiveSettings();
    if (!s.enabled) {
        return '';
    }
    return assembleSummaryBlock() || '';
}

function getStandardInjectionOptions() {
    return {
        position: EXTENSION_PROMPT_POSITIONS.IN_PROMPT,
        depth: 0,
        scan: false,
        role: EXTENSION_PROMPT_ROLES.SYSTEM,
    };
}

function mapMemoryPosition(position) {
    if (position === MEMORY_POSITIONS.BEFORE_PROMPT) {
        return EXTENSION_PROMPT_POSITIONS.BEFORE_PROMPT;
    }
    if (position === MEMORY_POSITIONS.IN_CHAT) {
        return EXTENSION_PROMPT_POSITIONS.IN_CHAT;
    }
    return EXTENSION_PROMPT_POSITIONS.IN_PROMPT;
}

function mapMemoryRole(role) {
    if (role === MEMORY_ROLES.USER) {
        return EXTENSION_PROMPT_ROLES.USER;
    }
    if (role === MEMORY_ROLES.ASSISTANT) {
        return EXTENSION_PROMPT_ROLES.ASSISTANT;
    }
    return EXTENSION_PROMPT_ROLES.SYSTEM;
}

function getInjectionKey(text, options) {
    return JSON.stringify({ text, options });
}

/**
 * Queue a best-effort memory diagnostic without delaying prompt updates.
 * @param {string} text - Injection text
 * @param {unknown[]} layers - Summary memory layers
 * @returns {void}
 */
function queueMemoryStatusLog(text, layers) {
    if (!isDebugEnabled()) {
        return;
    }
    void logMemoryStatus(text, layers);
}

/**
 * Count and log compact memory status.
 * @param {string} text - Injection text
 * @param {unknown[]} layers - Summary memory layers
 * @returns {Promise<void>}
 */
async function logMemoryStatus(text, layers) {
    try {
        const tokenCount = await countTextTokens(text);
        debug(
            `Memory updated: inject ${formatTokenCount(tokenCount)} tokens; ${formatLayerCounts(layers)}`,
        );
    } catch (e) {
        debug(`Memory updated: inject ? tokens; ${formatLayerCounts(layers)}`, e);
    }
}

function formatLayerCounts(layers) {
    if (!Array.isArray(layers) || layers.length === 0) {
        return 'layers L0=0';
    }

    const highestLayer = getHighestLayerIndex(layers);
    const parts = [];
    for (let i = 0; i <= highestLayer; i++) {
        const layer = layers[i];
        parts.push(`L${i}=${Array.isArray(layer) ? layer.length : 0}`);
    }
    return `layers ${parts.join(' ')}`;
}

function getHighestLayerIndex(layers) {
    for (let i = layers.length - 1; i >= 0; i--) {
        if (Array.isArray(layers[i]) && layers[i].length > 0) {
            return i;
        }
    }
    return 0;
}
