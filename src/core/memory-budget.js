import { getEffectiveSettings } from '../foundation/state.js';
import { buildMemoryInjectionParts } from './memory-injection.js';
import { countTextTokens } from './token-count.js';

/**
 * @typedef {object} EffectiveMemoryTokenPart
 * @property {string} label - Display label for the token part.
 * @property {string} kind - UI category for the token part.
 * @property {number} count - Token count for this part.
 * @property {boolean} estimated - Whether the count came from the fallback estimator.
 * @property {number} [layerIndex] - Source layer index for layer parts.
 */

/**
 * @typedef {object} EffectiveMemoryUsage
 * @property {{ count: number, estimated: boolean }} total - Total assembled injection tokens.
 * @property {string} text - Full injection text after template wrapping.
 * @property {EffectiveMemoryTokenPart | null} state - Current-state token part, when present.
 * @property {EffectiveMemoryTokenPart[]} layers - Chronology token parts by layer.
 * @property {EffectiveMemoryTokenPart | null} wrapper - Template/wrapper token part, when present.
 * @property {EffectiveMemoryTokenPart[]} parts - Display-ready token parts aligned to the total.
 */

/**
 * Build the full injected memory text for arbitrary layers/settings.
 * @param {Array<Array<{ text: string }>>} layers
 * @param {ExtensionSettings} [settings]
 * @returns {string}
 */
export function buildEffectiveMemoryText(layers, settings = getEffectiveSettings()) {
    const memory = buildMemoryInjectionParts(layers).memoryText;
    if (!memory) {
        return '';
    }
    return String(settings.injectionTemplate || '{{summary}}').replace('{{summary}}', memory);
}

/**
 * Count the exact assembled memory injection and expose budget display parts.
 * @param {Array<Array<{ text: string }>>} layers
 * @param {ExtensionSettings} [settings]
 * @returns {Promise<EffectiveMemoryUsage>}
 */
export async function getEffectiveMemoryUsage(layers, settings = getEffectiveSettings()) {
    const injectionParts = buildMemoryInjectionParts(layers);
    const text = injectionParts.memoryText
        ? String(settings.injectionTemplate || '{{summary}}').replace(
              '{{summary}}',
              injectionParts.memoryText,
          )
        : '';

    if (!text) {
        return emptyUsage();
    }

    const total = await countTextTokens(text);
    const state = await countStatePart(injectionParts.stateText);
    const layerParts = await countLayerParts(injectionParts.chronologyParts);
    const countedParts = [state, ...layerParts].filter(Boolean);
    const wrapper = buildWrapperPart(total, countedParts);
    const parts = [state, ...layerParts, wrapper].filter(Boolean);

    return {
        total: { count: total.count, estimated: total.estimated },
        text,
        state,
        layers: layerParts,
        wrapper,
        parts: alignPartsToTotal(parts, total.count),
    };
}

async function countStatePart(stateText) {
    if (!stateText) {
        return null;
    }
    const tokens = await countTextTokens(stateText);
    return {
        label: 'State',
        kind: 'state',
        count: tokens.count,
        estimated: tokens.estimated,
    };
}

async function countLayerParts(chronologyParts) {
    const parts = [];
    for (const part of chronologyParts) {
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

function sumPartCounts(parts) {
    return parts.reduce((sum, part) => sum + part.count, 0);
}

function emptyUsage() {
    return {
        total: { count: 0, estimated: false },
        text: '',
        state: null,
        layers: [],
        wrapper: null,
        parts: [],
    };
}
