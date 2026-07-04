import { MODULE_NAME } from '../foundation/constants.js';
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

    if (!store.layers || store.layers.every((l) => !l || l.length === 0)) {
        return '';
    }

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) {
            continue;
        }
        for (const sn of layer) {
            snippets.push(sn.text);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn.text);
        }
    }

    if (snippets.length === 0) {
        return '';
    }

    return s.injectionTemplate.replace('{{summary}}', snippets.join(' '));
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjected = '';
let _activeInjectionSnapshot = null;

/**
 *
 */
export function updateInjection() {
    try {
        if (isPromptMutationFrozen()) {
            return;
        }

        const nextInjection = buildEnabledInjectionText();
        _activeInjectionSnapshot = nextInjection;

        if (nextInjection === _lastInjected) {
            return;
        }

        setExtensionPrompt(MODULE_NAME, nextInjection);
        _lastInjected = nextInjection;

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

        setExtensionPrompt(MODULE_NAME, _activeInjectionSnapshot);
        _lastInjected = _activeInjectionSnapshot;
        queueInjectionTokenLog('Injection snapshot reasserted', _activeInjectionSnapshot);
    } catch (e) {
        log('reassertInjectionSnapshot error:', e);
    }
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
