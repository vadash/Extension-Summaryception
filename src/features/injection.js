import { MODULE_NAME } from '../foundation/constants.js';
import { getChatStore, getSettings } from '../foundation/state.js';
import { log } from '../foundation/logger.js';
import { isPromptMutationFrozen } from '../core/summarizer-commit.js';

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
        const { setExtensionPrompt } = SillyTavern.getContext();

        if (isPromptMutationFrozen()) {
            reassertInjectionSnapshot();
            return;
        }

        const nextInjection = buildEnabledInjectionText();
        _activeInjectionSnapshot = nextInjection;

        if (nextInjection === _lastInjected) {
            return;
        }

        setExtensionPrompt(MODULE_NAME, nextInjection, 0, 0, false, 0);
        _lastInjected = nextInjection;

        log(`Injection updated: ${nextInjection.length} chars`);
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
        const { setExtensionPrompt } = SillyTavern.getContext();
        if (_activeInjectionSnapshot === null) {
            _activeInjectionSnapshot = buildEnabledInjectionText();
        }

        setExtensionPrompt(MODULE_NAME, _activeInjectionSnapshot, 0, 0, false, 0);
        _lastInjected = _activeInjectionSnapshot;
        log(`Injection snapshot reasserted: ${_activeInjectionSnapshot.length} chars`);
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
