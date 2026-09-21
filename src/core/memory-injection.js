import { getEffectiveSettings } from '../foundation/settings.js';
import {
    formatAnchoredSnippetNarrative,
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
} from './snippet-metadata.js';
import { countTextTokens } from './token-count.js';

/**
 * @typedef {object} MemoryInjectionParts
 * @property {Array<{ layerIndex: number, text: string }>} chronologyParts - Per-layer chronology sections.
 * @property {string} chronologyText - Joined chronology section text.
 * @property {string} memoryText - Final memory body before template wrapping.
 */

/**
 * The read model of what ships in the prompt slot: compact anchors,
 * template-wrapped, with the per-layer parts kept for cost display.
 * @typedef {object} MemoryInjection
 * @property {string} text - Prompt-slot text; empty when there are no memories.
 * @property {Array<{ layerIndex: number, text: string }>} parts - Chronology sections, deepest first.
 */

/**
 * @typedef {object} MemoryInjectionTokenPart
 * @property {string} label - Display label for the token part.
 * @property {string} kind - UI category for the token part.
 * @property {number} count - Token count for this part.
 * @property {boolean} estimated - Whether the count came from the fallback estimator.
 * @property {number} [layerIndex] - Source layer index for layer parts.
 */

/**
 * @typedef {object} MemoryInjectionUsage
 * @property {{ count: number, estimated: boolean }} total - Total tokens of the measured text.
 * @property {MemoryInjectionTokenPart[]} layers - Chronology token parts by layer.
 * @property {MemoryInjectionTokenPart | null} wrapper - Template/wrapper token part, when present.
 * @property {MemoryInjectionTokenPart[]} parts - Display-ready token parts aligned to the total.
 */

/**
 * The bare memory body handed to the summarizer as context: full anchors,
 * per-layer sections, never template-wrapped.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {string}
 */
export function buildMemoryBody(layers) {
    return buildMemoryInjectionParts(layers).memoryText;
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {ExtensionSettings} [settings]
 * @returns {MemoryInjection}
 */
export function buildInjection(layers, settings = getEffectiveSettings()) {
    const { chronologyParts, memoryText } = buildMemoryInjectionParts(layers, {
        compactAnchors: true,
    });

    return {
        text: memoryText ? renderInjectionTemplate({ memoryText }, settings) : '',
        parts: chronologyParts,
    };
}

/**
 * Count the text it was handed. Taking the injection rather than the layers is
 * what keeps the displayed cost and the injected prompt the same string.
 * @param {MemoryInjection} injection
 * @returns {Promise<MemoryInjectionUsage>}
 */
export async function measureInjection(injection) {
    const text = String(injection?.text ?? '');
    if (!text) {
        return emptyUsage();
    }

    const total = await countTextTokens(text);
    const layerParts = await countLayerParts(injection.parts);
    const wrapper = buildWrapperPart(total, layerParts);
    const parts = [...layerParts, wrapper].filter((part) => part !== null);

    return {
        total: { count: total.count, estimated: total.estimated },
        layers: layerParts,
        wrapper,
        parts: alignPartsToTotal(parts, total.count),
    };
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

/**
 * @param {Array<{ layerIndex: number, text: string }>} chronologyParts
 * @returns {Promise<MemoryInjectionTokenPart[]>}
 */
async function countLayerParts(chronologyParts) {
    const parts = [];
    for (const part of chronologyParts || []) {
        const tokens = await countTextTokens(part.text);
        parts.push({
            label: `Layer ${part.layerIndex}`,
            kind: part.layerIndex === 0 ? 'layer0' : 'layer',
            layerIndex: part.layerIndex,
            count: tokens.count,
            estimated: tokens.estimated,
        });
    }
    return parts;
}

/**
 * @param {{ count: number, estimated: boolean }} total
 * @param {MemoryInjectionTokenPart[]} countedParts
 * @returns {MemoryInjectionTokenPart | null}
 */
function buildWrapperPart(total, countedParts) {
    const partTotal = sumPartCounts(countedParts);
    const count = Math.max(0, total.count - partTotal);
    if (count === 0) {
        return null;
    }
    return {
        label: 'Wrapper',
        kind: 'wrapper',
        count,
        estimated: total.estimated || countedParts.some((part) => part.estimated),
    };
}

/**
 * @param {MemoryInjectionTokenPart[]} parts
 * @param {number} totalCount
 * @returns {MemoryInjectionTokenPart[]}
 */
function alignPartsToTotal(parts, totalCount) {
    const excess = sumPartCounts(parts) - totalCount;
    if (excess <= 0) {
        return parts;
    }

    const adjusted = parts.map((part) => ({ ...part }));
    let remaining = excess;
    for (let i = adjusted.length - 1; i >= 0 && remaining > 0; i--) {
        const removable = Math.min(adjusted[i].count, remaining);
        adjusted[i].count -= removable;
        remaining -= removable;
    }
    return adjusted.filter((part) => part.count > 0);
}

/**
 * @param {MemoryInjectionTokenPart[]} parts
 * @returns {number}
 */
function sumPartCounts(parts) {
    return parts.reduce((sum, part) => sum + part.count, 0);
}

/**
 * @returns {MemoryInjectionUsage}
 */
function emptyUsage() {
    return {
        total: { count: 0, estimated: false },
        layers: [],
        wrapper: null,
        parts: [],
    };
}

/**
 * @returns {MemoryInjectionParts}
 */
function emptyParts() {
    return {
        chronologyParts: [],
        chronologyText: '',
        memoryText: '',
    };
}
