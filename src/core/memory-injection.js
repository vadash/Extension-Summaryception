import { compileGlobalState, parseSnippet, serializeState } from './summarizer-state.js';
import {
    formatAnchoredSnippetNarrative,
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
} from './snippet-metadata.js';

/**
 * @typedef {object} MemoryInjectionParts
 * @property {string} stateText - Serialized current-state section.
 * @property {Array<{ layerIndex: number, text: string }>} chronologyParts - Per-layer chronology sections.
 * @property {string} chronologyText - Joined chronology section text.
 * @property {string} memoryText - Final memory body before template wrapping.
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
 * @param {{ compactAnchors?: boolean, injectCurrentState?: boolean }} [options]
 * @returns {MemoryInjectionParts}
 */
export function buildMemoryInjectionParts(
    layers,
    { compactAnchors = false, injectCurrentState = true } = {},
) {
    if (!Array.isArray(layers)) {
        return emptyParts();
    }

    const stateText = injectCurrentState ? buildCurrentStateText(layers) : '';
    const chronologyParts = collectChronologyParts(layers, compactAnchors);
    const chronologyText = chronologyParts.map((part) => part.text).join('\n');
    const memoryText = combineMemoryText(stateText, chronologyText);

    return { stateText, chronologyParts, chronologyText, memoryText };
}

/**
 * Substitute the memory body into the configured injection template.
 * The replacer is a function so `$` sequences in memory text are never
 * treated as replacement patterns.
 * @param {{ memoryText?: string }} injectionParts - Injection parts carrying the memory body.
 * @param {{ injectionTemplate?: string }} [settings] - Settings carrying the wrapper template.
 * @param {{ emptyFallback?: string }} [options] - Text used when the memory body is empty.
 * @returns {string}
 */
export function renderInjectionTemplate(injectionParts, settings, { emptyFallback = '' } = {}) {
    return String(settings?.injectionTemplate || '{{summary}}').replaceAll(
        '{{summary}}',
        () => injectionParts.memoryText || emptyFallback || '',
    );
}

function buildCurrentStateText(layers) {
    return getCurrentStateSnapshotText(layers).replace(/^\[STATE\]/, '[CURRENT STATE]');
}

/**
 * Return the raw serialized current `[STATE]` body (no `[CURRENT STATE]`
 * rename) for the source-state token/key counts used by the Layer 0 budget
 * hint. Returns `''` when the layers hold no state.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {string}
 */
export function getCurrentStateSnapshotText(layers) {
    if (!Array.isArray(layers)) {
        return '';
    }
    const state = compileGlobalState(layers);
    if (Object.keys(state).length === 0) {
        return '';
    }
    return serializeState(state);
}

function collectChronologyParts(layers, compactAnchors) {
    const parts = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        const text = layer
            .map((snippet) => buildChronologySnippetText(snippet, i, compactAnchors))
            .filter(Boolean)
            .join('\n');
        if (text) {
            parts.push({ layerIndex: i, text });
        }
    }
    return parts;
}

function buildChronologySnippetText(snippet, layerIndex, compactAnchors) {
    const pieces = [
        formatAnchoredSnippetNarrative(
            snippet,
            compactAnchors ? formatCompactSnippetAnchor : formatSnippetAnchor,
        ),
    ];
    if (layerIndex > 0) {
        pieces.push(formatHistoricalStateNote(parseSnippet(snippet?.text || '').state));
    }
    return pieces.filter(Boolean).join(' ');
}

function formatHistoricalStateNote(state) {
    const entries = Object.entries(state || {})
        .map(([key, value]) => [String(key).trim(), String(value ?? '').trim()])
        .filter(([key, value]) => key && value);
    if (entries.length === 0) {
        return '';
    }
    const facts = entries.map(([key, value]) => `${key} is ${value}`).join('; ');
    return `[Historical note: ${facts}]`;
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
