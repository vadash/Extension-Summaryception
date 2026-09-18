import {
    formatAnchoredSnippetNarrative,
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
} from './snippet-metadata.js';

/**
 * @typedef {object} MemoryInjectionParts
 * @property {Array<{ layerIndex: number, text: string }>} chronologyParts - Per-layer chronology sections.
 * @property {string} chronologyText - Joined chronology section text.
 * @property {string} memoryText - Final memory body before template wrapping.
 */

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {string}
 */
export function buildMemoryInjection(layers) {
    return buildMemoryInjectionParts(layers).memoryText;
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {{ compactAnchors?: boolean }} [options]
 * @returns {MemoryInjectionParts}
 */
export function buildMemoryInjectionParts(layers, { compactAnchors = false } = {}) {
    if (!Array.isArray(layers)) {
        return emptyParts();
    }

    const chronologyParts = collectChronologyParts(layers, compactAnchors);
    const chronologyText = chronologyParts.map((part) => part.text).join('\n');
    const memoryText = chronologyText ? `[CHRONOLOGY]\n${chronologyText}` : '';

    return { chronologyParts, chronologyText, memoryText };
}

/**
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

function collectChronologyParts(layers, compactAnchors) {
    const parts = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        const text = layer
            .map((snippet) =>
                formatAnchoredSnippetNarrative(
                    snippet,
                    compactAnchors ? formatCompactSnippetAnchor : formatSnippetAnchor,
                ),
            )
            .filter(Boolean)
            .join('\n');
        if (text) {
            parts.push({ layerIndex: i, text });
        }
    }
    return parts;
}

function emptyParts() {
    return {
        chronologyParts: [],
        chronologyText: '',
        memoryText: '',
    };
}
