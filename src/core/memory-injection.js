import { compileGlobalState, parseSnippet, serializeState } from './summarizer-state.js';
import {
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
    stripLeadingSnippetAnchor,
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
 * @param {{ compactAnchors?: boolean }} [options]
 * @returns {MemoryInjectionParts}
 */
export function buildMemoryInjectionParts(layers, { compactAnchors = false } = {}) {
    if (!Array.isArray(layers)) {
        return emptyParts();
    }

    const stateText = buildCurrentStateText(layers);
    const chronologyParts = collectChronologyParts(layers, compactAnchors);
    const chronologyText = chronologyParts.map((part) => part.text).join('\n');
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
    const parsed = parseSnippet(snippet?.text || '');
    const anchor = compactAnchors
        ? formatCompactSnippetAnchor(snippet)
        : formatSnippetAnchor(snippet);
    const narrative = anchor
        ? stripLeadingSnippetAnchor(parsed.narrative)
        : parsed.narrative.trim();
    const pieces = [anchor, narrative];
    if (layerIndex > 0) {
        const historicalStateNote = formatHistoricalStateNote(parsed.state);
        if (historicalStateNote) {
            pieces.push(historicalStateNote);
        }
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
