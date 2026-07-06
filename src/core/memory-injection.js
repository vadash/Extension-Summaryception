import { compileGlobalState, parseSnippet, serializeState } from './summarizer-state.js';

/**
 * @typedef {object} MemoryInjectionParts
 * @property {string} stateText
 * @property {Array<{ layerIndex: number, text: string }>} chronologyParts
 * @property {string} chronologyText
 * @property {string} memoryText
 */

/**
 * Build clean dual-track memory from summary layers.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {string}
 */
export function buildMemoryInjection(layers) {
    return buildMemoryInjectionParts(layers).memoryText;
}

/**
 * Build memory injection sections while preserving per-layer chronology parts.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {MemoryInjectionParts}
 */
export function buildMemoryInjectionParts(layers) {
    if (!Array.isArray(layers)) {
        return emptyParts();
    }

    const stateText = buildCurrentStateText(layers);
    const chronologyParts = collectChronologyParts(layers);
    const chronologyText = chronologyParts.map((part) => part.text).join(' ');
    const memoryText = combineMemoryText(stateText, chronologyText);

    return { stateText, chronologyParts, chronologyText, memoryText };
}

function buildCurrentStateText(layers) {
    const state = compileGlobalState(layers);
    if (Object.keys(state).length === 0) {
        return '';
    }

    return serializeState(state).replace(/^\[STATE\]/, '[CURRENT STATE]');
}

function collectChronologyParts(layers) {
    const parts = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        const text = layer
            .map((snippet) => parseSnippet(snippet?.text || '').narrative)
            .filter(Boolean)
            .join(' ');
        if (text) {
            parts.push({ layerIndex: i, text });
        }
    }
    return parts;
}

function combineMemoryText(stateText, chronologyText) {
    const parts = [];
    if (stateText) {
        parts.push(stateText, '');
    }
    if (chronologyText) {
        parts.push('[CHRONOLOGY]', chronologyText);
    }
    return parts.join('\n');
}

function emptyParts() {
    return {
        stateText: '',
        chronologyParts: [],
        chronologyText: '',
        memoryText: '',
    };
}
