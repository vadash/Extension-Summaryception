import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
} from '../foundation/constants.js';
import { setExtensionPrompt } from '../foundation/context.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { isDebugEnabled, log } from '../foundation/logger.js';
import { isPromptMutationFrozen } from '../core/summarizer-commit.js';
import { countTextTokens, formatTokenCount } from '../core/token-count.js';

// ─── Core: Assemble Full Summary Block ──────────────────────────────

/**
 * Build the summary block by combining all layer snippets.
 * @returns {string} The assembled summary block, or '' if no snippets exist
 */
export function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    const layeredSummary = assembleLayerBlocks(store.layers);
    if (!layeredSummary) {
        return '';
    }

    return s.injectionTemplate.replace('{{summary}}', layeredSummary);
}

function assembleLayerBlocks(layers) {
    if (!Array.isArray(layers)) {
        return '';
    }

    const blocks = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const block = formatLayerBlock(i, layers[i]);
        if (block) {
            blocks.push(block);
        }
    }

    return blocks.join('\n\n');
}

function formatLayerBlock(layerIndex, layer) {
    if (!Array.isArray(layer) || layer.length === 0) {
        return '';
    }

    const text = layer
        .map((snippet) => snippet.text)
        .filter((snippetText) => snippetText)
        .join(' ');

    if (!text) {
        return '';
    }

    return `<L${layerIndex}>\n${text}\n</L${layerIndex}>`;
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjectionKey = '';
let _activeInjectionSnapshot = null;
let _activeInjectionOptions = null;

/**
 *
 */
export function updateInjection() {
    try {
        if (isPromptMutationFrozen()) {
            return;
        }

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

        queueInjectionTokenLog('Injection updated', nextInjection);
    } catch (e) {
        log('updateInjection error:', e);
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
        queueInjectionTokenLog('Injection snapshot reasserted', _activeInjectionSnapshot);
    } catch (e) {
        log('reassertInjectionSnapshot error:', e);
    }
}

/**
 * Resolve SillyTavern extension prompt options from the configured memory mode.
 * @param {ExtensionSettings} [settings]
 * @returns {{ position: number, depth: number, scan: boolean, role: number }}
 */
export function getMemoryInjectionOptions(settings = getSettings()) {
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
    const s = getSettings();
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
 * Queue a best-effort token diagnostic without delaying prompt updates.
 * @param {string} label - Log message prefix
 * @param {string} text - Injection text
 * @returns {void}
 */
function queueInjectionTokenLog(label, text) {
    if (!isDebugEnabled()) {
        return;
    }
    void logInjectionTokenCount(label, text);
}

/**
 * Count and log injection tokens.
 * @param {string} label - Log message prefix
 * @param {string} text - Injection text
 * @returns {Promise<void>}
 */
async function logInjectionTokenCount(label, text) {
    try {
        const tokenCount = await countTextTokens(text);
        log(`${label}: ${formatTokenCount(tokenCount)} tokens`);
    } catch (e) {
        log(`${label}: ? tokens`, e);
    }
}
