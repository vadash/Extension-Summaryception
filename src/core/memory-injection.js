import { MEMORY_MODES, MICROFICHE_GEOMETRY_PRESETS } from '../foundation/constants.js';
import { getChat } from '../foundation/context.js';
import { normalizePreservedMessages } from '../foundation/chat-store.js';
import { getMessageIndexByScId } from '../foundation/message-identity.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { buildMicrofichePlan, buildMicroficheRawPlan } from './microfiche-policy.js';
import { formatAnchoredSnippetNarrative } from './snippet-metadata.js';
import { isGuardMaskEnabled, maskGuardText } from './guard-mask.js';
import { countTextTokens } from './token-count.js';

/**
 * @typedef {object} MemorySnippetEntry
 * @property {'snippet'} kind - Entry discriminator.
 * @property {string} text - Anchored snippet text.
 * @property {number} layerIndex - Source layer for accounting.
 * @property {number} order - Deepest-first fallback order.
 * @property {number | null} start - First resolved source Chat Index.
 * @property {number | null} end - Last resolved source Chat Index.
 */

/**
 * @typedef {object} MemoryPreservedEntry
 * @property {'preserved'} kind - Entry discriminator.
 * @property {string} text - Anchored approved snapshot.
 * @property {number} index - Resolved source Chat Index.
 * @property {number} order - Approved-record fallback order.
 */

/**
 * @typedef {object} MemoryInjectionParts
 * @property {Array<{ layerIndex: number, text: string }>} chronologyParts - Per-layer chronology sections.
 * @property {string} chronologyText - Joined per-layer chronology section text.
 * @property {string} memoryText - Final memory body before template wrapping.
 * @property {string} snippetText - Snippet-only body in the same global order.
 * @property {string} preservedText - Handed-off Preserved Message blocks in source order.
 * @property {Array<MemorySnippetEntry | MemoryPreservedEntry>} entries - Globally ordered memory entries.
 */

/**
 * @typedef {object} MemoryInjection
 *
 * The read model of what ships in the prompt slot: the Snippet Anchor form,
 * template-wrapped, with the per-layer parts kept for cost display. Microfiche
 * mode carries the image pages plus the text tail, so the image cap and the raw
 * bucket are enforced in product and nothing drops silently.
 * @property {string} text - Prompt-slot text; empty when there are no memories.
 * @property {Array<{ layerIndex: number, text: string }>} parts - Chronology sections, deepest first.
 * @property {Array<{ text: string }>} preservedParts - Exact preserved text counted separately from layers.
 * @property {import('./microfiche-policy.js').MicrofichePlan | null} microfiche - Built memory plan for Microfiche mode, else null.
 * @property {import('./microfiche-policy.js').MicroficheRawPlan | null} microficheRaw - Frozen raw-chat plan for the raw image region, else null.
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
 * @property {MemoryInjectionTokenPart | null} preserved - Exact Preserved Message tokens, excluded from layer usage.
 * @property {MemoryInjectionTokenPart[]} layers - Chronology token parts by layer.
 * @property {MemoryInjectionTokenPart | null} wrapper - Template/wrapper token part, when present.
 * @property {MemoryInjectionTokenPart[]} parts - Display-ready token parts aligned to the total.
 */

/**
 * The bare memory body handed to the summarizer as context: snippet-only text
 * in global source order with the same anchors as the injection, never template-wrapped.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {string}
 */
export function buildMemoryBody(layers) {
    return buildMemoryInjectionParts(layers).memoryText;
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {ExtensionSettings} [settings]
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @param {{ rawTexts?: string[] | null, chat?: ChatMessage[] | null, preservedMessages?: SummaryceptionPreservedMessage[] | null }} [options] - Raw slice plus live source identity and approved records.
 * @returns {MemoryInjection}
 */
export function buildInjection(
    layers,
    settings = getEffectiveSettings(),
    host = null,
    { rawTexts = null, chat = null, preservedMessages = null } = {},
) {
    const source = settings ?? {};
    const { chronologyParts, entries, memoryText, snippetText, preservedText } =
        buildMemoryInjectionParts(layers, { chat, preservedMessages });
    const preservedParts = preservedText ? [{ text: preservedText }] : [];
    const maskMemory = Boolean(
        source.enabled && source.guardMaskMemory && isGuardMaskEnabled(source),
    );
    const text = memoryText ? renderInjectionTemplate({ memoryText, snippetText }, source) : '';
    const split = buildMicroficheSplit(source, host, {
        entries,
        maskMemory,
        rawTexts,
    });
    return {
        text: maskMemory ? maskGuardText(text) : text,
        parts: maskMemory
            ? chronologyParts.map((part) => ({ ...part, text: maskGuardText(part.text) }))
            : chronologyParts,
        preservedParts: maskMemory
            ? preservedParts.map((part) => ({ text: maskGuardText(part.text) }))
            : preservedParts,
        microfiche: split.microfiche,
        microficheRaw: split.microficheRaw,
    };
}

/**
 * @param {ExtensionSettings} settings
 * @param {{ imageBudget?: unknown } | null} [host] - Injected host adapter budget, if any.
 * @param {{ entries?: Array<{ kind: 'snippet' | 'preserved', text: string }>, maskMemory?: boolean, rawTexts?: unknown }} [options] - Ordered memory entries, slot masking, and frozen raw-chat slice.
 * @returns {{ microfiche: import('./microfiche-policy.js').MicrofichePlan | null, microficheRaw: import('./microfiche-policy.js').MicroficheRawPlan | null }}
 */
function buildMicroficheSplit(
    settings,
    host = null,
    { entries = [], maskMemory = false, rawTexts = null } = {},
) {
    const empty = { microfiche: null, microficheRaw: null };
    if (settings?.memoryMode !== MEMORY_MODES.MICROFICHE) {
        return empty;
    }
    const name = String(settings.microficheGeometry ?? '');
    if (!MICROFICHE_GEOMETRY_PRESETS[name] && name !== 'custom') {
        return empty;
    }
    const planSettings = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (settings));
    const microfiche = buildMemoryPlanEntry(entries, planSettings, host, maskMemory);
    const rawSlice = normalizeRawTexts(rawTexts);
    const microficheRaw = buildMicroficheRawPlan(rawSlice, planSettings, host, microfiche);
    return { microfiche, microficheRaw };
}

/**
 * @param {Array<{ kind: 'snippet' | 'preserved', text: string }>} entries
 * @param {Record<string, unknown>} settings
 * @param {{ imageBudget?: unknown } | null} host
 * @param {boolean} maskMemory
 * @returns {import('./microfiche-policy.js').MicrofichePlan | null}
 */
function buildMemoryPlanEntry(entries, settings, host, maskMemory) {
    const planEntries = entries.map((entry) => {
        const text = maskMemory ? maskGuardText(entry.text) : entry.text;
        return entry.kind === 'preserved' ? { text, literal: true } : { text };
    });
    if (planEntries.length === 0) {
        return null;
    }
    return buildMicrofichePlan(planEntries, settings, host);
}

/**
 * @param {unknown} rawTexts - Frozen raw-chat slice, oldest first.
 * @returns {string[]} String slice in place order.
 */
function normalizeRawTexts(rawTexts) {
    if (!Array.isArray(rawTexts)) {
        return [];
    }
    return rawTexts.filter((text) => typeof text === 'string' && text.length > 0);
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
    const preserved = await countPreservedPart(injection.preservedParts);
    const countedParts = [...layerParts, ...(preserved ? [preserved] : [])];
    const wrapper = buildWrapperPart(total, countedParts);
    const parts = [...countedParts, wrapper].filter((part) => part !== null);

    return {
        total: { count: total.count, estimated: total.estimated },
        layers: layerParts,
        preserved,
        wrapper,
        parts: alignPartsToTotal(parts, total.count),
    };
}

/**
 * @param {Array<{ text: string }> | null | undefined} preservedParts
 * @returns {Promise<MemoryInjectionTokenPart | null>}
 */
async function countPreservedPart(preservedParts) {
    const text = (Array.isArray(preservedParts) ? preservedParts : [])
        .map((part) => part?.text)
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join('\n');
    if (!text) {
        return null;
    }
    const tokens = await countTextTokens(text);
    return {
        label: 'Preserved',
        kind: 'preserved',
        count: tokens.count,
        estimated: tokens.estimated,
    };
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {{ chat?: ChatMessage[] | null, preservedMessages?: SummaryceptionPreservedMessage[] | null }} [options] - Live source identity and approved records.
 * @returns {MemoryInjectionParts}
 */
export function buildMemoryInjectionParts(layers, { chat = null, preservedMessages = null } = {}) {
    if (!Array.isArray(layers)) {
        return emptyParts();
    }
    const sourceChat = resolveSourceChat(chat);
    const messageIndices = getMessageIndexByScId(sourceChat);
    const chronologyParts = collectChronologyParts(layers, messageIndices);
    // The injection template legend names the section, so the body carries no heading.
    const chronologyText = chronologyParts.map((part) => part.text).join('\n');
    const entries = orderMemoryEntries(
        collectSnippetEntries(layers, sourceChat),
        collectPreservedEntries(sourceChat, preservedMessages),
    );
    const snippetText = entries
        .filter((entry) => entry.kind === 'snippet')
        .map((entry) => entry.text)
        .join('\n');
    const preservedText = entries
        .filter((entry) => entry.kind === 'preserved')
        .map((entry) => entry.text)
        .join('\n');
    const memoryText = entries.map((entry) => entry.text).join('\n');

    return { chronologyParts, chronologyText, memoryText, snippetText, preservedText, entries };
}

/**
 * The replacer is a function so `$` sequences in memory text are never
 * treated as replacement patterns. Only the first placeholder carries
 * Preserved Messages; later recall copies stay snippet-only.
 * @param {{ memoryText?: string, snippetText?: string }} injectionParts - Injection parts carrying the memory body.
 * @param {{ injectionTemplate?: string }} [settings] - Settings carrying the wrapper template.
 * @param {{ emptyFallback?: string }} [options] - Text used when the memory body is empty.
 * @returns {string}
 */
export function renderInjectionTemplate(injectionParts, settings, { emptyFallback = '' } = {}) {
    let first = true;
    return String(settings?.injectionTemplate || '{{summary}}').replaceAll('{{summary}}', () => {
        const useFirst = first;
        first = false;
        const body = useFirst
            ? injectionParts.memoryText
            : (injectionParts.snippetText ?? injectionParts.memoryText);
        return body || (useFirst ? emptyFallback || '' : '');
    });
}

function resolveSourceChat(chat) {
    if (Array.isArray(chat)) {
        return chat;
    }
    try {
        const liveChat = getChat();
        return Array.isArray(liveChat) ? liveChat : [];
    } catch (_error) {
        return [];
    }
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {ChatMessage[]} chat
 * @returns {MemorySnippetEntry[]}
 */
function collectSnippetEntries(layers, chat) {
    const messageIndices = getMessageIndexByScId(chat);
    /** @type {MemorySnippetEntry[]} */
    const entries = [];
    let order = 0;
    for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex--) {
        const layer = layers[layerIndex];
        if (!Array.isArray(layer)) {
            continue;
        }
        for (const snippet of layer) {
            const currentOrder = order++;
            const { text, indices } = formatSnippetEntry(snippet, messageIndices);
            if (!text) {
                continue;
            }
            entries.push({
                kind: 'snippet',
                text,
                layerIndex,
                order: currentOrder,
                start: indices[0] ?? null,
                end: indices.at(-1) ?? null,
            });
        }
    }
    return entries;
}

/**
 * @param {{ text: string, sourceMessageIds?: string[], currentDateTime?: string }} snippet
 * @param {Map<string, number>} messageIndices
 * @returns {{ text: string, indices: number[] }}
 */
function formatSnippetEntry(snippet, messageIndices) {
    const indices = (Array.isArray(snippet?.sourceMessageIds) ? snippet.sourceMessageIds : [])
        .flatMap((id) => {
            const index = messageIndices.get(id);
            return index === undefined ? [] : [index];
        })
        .sort((left, right) => left - right);
    const text = formatAnchoredSnippetNarrative(snippet, (source) =>
        formatSnippetAnchor(source, indices),
    );
    return { text, indices };
}

/**
 * @param {{ currentDateTime?: string }} snippet
 * @param {number[]} indices
 * @returns {string}
 */
function formatSnippetAnchor(snippet, indices) {
    if (indices.length === 0) {
        return '';
    }
    const sceneTime = formatCompactSceneTime(snippet.currentDateTime);
    const time = sceneTime && sceneTime.toLowerCase() !== 'unknown' ? `@${sceneTime}` : '';
    return `[${indices[0]}-${indices.at(-1)}${time}]`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatCompactSceneTime(value) {
    const rawTime = typeof value === 'string' ? value.trim() : '';
    const compact = /^(\d{4}-\d{2}-\d{2})\s+(\d{2})(?:\s+[a-z]{3})?$/i.exec(rawTime);
    return compact ? `${compact[1]}T${compact[2]}` : rawTime;
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionPreservedMessage[] | null | undefined} preservedMessages
 * @returns {MemoryPreservedEntry[]}
 */
function collectPreservedEntries(chat, preservedMessages) {
    const messageIndices = getMessageIndexByScId(chat);
    /** @type {MemoryPreservedEntry[]} */
    const entries = [];
    let order = 0;
    for (const record of normalizePreservedMessages(preservedMessages)) {
        const index = messageIndices.get(record.id);
        if (!record.handedOff || index === undefined) {
            continue;
        }
        entries.push({
            kind: 'preserved',
            text: formatPreservedBlock(record, index),
            index,
            order: order++,
        });
    }
    return entries;
}

function formatPreservedBlock(record, index) {
    const sceneTime = formatCompactSceneTime(record.currentDateTime);
    const time = sceneTime && sceneTime.toLowerCase() !== 'unknown' ? `@${sceneTime}` : '';
    return `[${index}-${index}${time}] <preserved>${record.text}</preserved>`;
}

/**
 * @param {MemorySnippetEntry[]} snippetEntries
 * @param {MemoryPreservedEntry[]} preservedEntries
 * @returns {Array<MemorySnippetEntry | MemoryPreservedEntry>}
 */
function orderMemoryEntries(snippetEntries, preservedEntries) {
    const snippets = snippetEntries.slice().sort((left, right) => {
        if (left.start !== null && right.start !== null && left.start !== right.start) {
            return left.start - right.start;
        }
        if (left.start !== null && right.start === null) {
            return -1;
        }
        if (left.start === null && right.start !== null) {
            return 1;
        }
        return left.order - right.order;
    });
    /** @type {Map<MemorySnippetEntry, MemoryPreservedEntry[]>} */
    const covered = new Map();
    /** @type {MemoryPreservedEntry[]} */
    const uncovered = [];
    for (const preserved of preservedEntries
        .slice()
        .sort((left, right) => left.index - right.index)) {
        const snippet = snippets.find(
            (candidate) =>
                candidate.start !== null &&
                candidate.end !== null &&
                candidate.start <= preserved.index &&
                candidate.end >= preserved.index,
        );
        if (!snippet) {
            uncovered.push(preserved);
            continue;
        }
        const records = covered.get(snippet) || [];
        records.push(preserved);
        covered.set(snippet, records);
    }

    /** @type {Array<MemorySnippetEntry | MemoryPreservedEntry>} */
    const ordered = [];
    let uncoveredIndex = 0;
    for (const snippet of snippets) {
        while (
            snippet.start !== null &&
            uncoveredIndex < uncovered.length &&
            uncovered[uncoveredIndex].index < snippet.start
        ) {
            ordered.push(uncovered[uncoveredIndex++]);
        }
        ordered.push(snippet);
        ordered.push(...(covered.get(snippet) || []));
    }
    ordered.push(...uncovered.slice(uncoveredIndex));
    return ordered;
}

/**
 * @param {Array<Array<{ text: string }>>} layers
 * @param {Map<string, number>} messageIndices
 * @returns {Array<{ layerIndex: number, text: string }>}
 */
function collectChronologyParts(layers, messageIndices) {
    const parts = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!Array.isArray(layer) || layer.length === 0) {
            continue;
        }
        const text = layer
            .map((snippet) => formatSnippetEntry(snippet, messageIndices).text)
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
        preserved: null,
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
        snippetText: '',
        preservedText: '',
        entries: [],
    };
}
