import { MODULE_NAME } from './constants.js';
import { getChatStore, getSettings } from './state.js';
import { log } from './logger.js';

// ─── Core: Assemble Full Summary Block ──────────────────────────────

export function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) return '';

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            snippets.push(sn.text);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn.text);
        }
    }

    if (snippets.length === 0) return '';

    return s.injectionTemplate.replace('{{summary}}', snippets.join(' '));
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjected = '';

export function updateInjection() {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        const s = getSettings();

        if (!s.enabled) {
            if (_lastInjected !== '') {
                setExtensionPrompt(MODULE_NAME, '', 0, 0, false, 0);
                _lastInjected = '';
            }
            return;
        }

        const summaryBlock = assembleSummaryBlock();
        if (summaryBlock === _lastInjected) return;

        setExtensionPrompt(MODULE_NAME, summaryBlock || '', 0, 0, false, 0);
        _lastInjected = summaryBlock || '';

        log(`Injection updated: ${(summaryBlock || '').length} chars`);
    } catch (e) {
        log('updateInjection error:', e);
    }
}
