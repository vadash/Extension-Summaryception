import { isPlainObject } from '../foundation/objects.js';

// The marker never collides with story prose or the summarizer contract:
// structural headers use angle-bracket tags (<narrative>, <declined>) while
// this codec uses a square-bracket token with a summaryception-microfiche
// namespace that model prose never emits. The digit-only page slot keeps the
// scan one linear pass with no backtracking.
const MICROFICHE_MARKER_RE = /\[summaryception-microfiche page=(\d+)\]/g;

const stubPages = new Map();

/**
 * Format the text-only slot marker for one microfiche page.
 * @param {number} pageIndex - Zero-based page index.
 * @returns {string} Single-line namespaced marker.
 */
export function formatMicroficheMarker(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new RangeError(
            `Microfiche page index must be a non-negative integer, got ${pageIndex}`,
        );
    }
    return `[summaryception-microfiche page=${pageIndex}]`;
}

/**
 * List every page index referenced by markers in the text.
 * @param {unknown} text - Candidate slot text.
 * @returns {number[]} Page indexes in encounter order.
 */
export function extractMicrofichePageIndices(text) {
    if (typeof text !== 'string') {
        return [];
    }
    const indices = [];
    for (const match of text.matchAll(MICROFICHE_MARKER_RE)) {
        const index = Number(match[1]);
        if (Number.isSafeInteger(index)) {
            indices.push(index);
        }
    }
    return indices;
}

/**
 * Stage one stub page for send-time expansion. Test and preview seam only;
 * the real renderer registers its own pages in a later ticket.
 * @param {number} pageIndex - Zero-based page index.
 * @param {{ dataUrl: string, text: string }} page - Stub image URL and fallback text.
 * @returns {void}
 */
export function registerMicroficheStubPage(pageIndex, page) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new RangeError(
            `Microfiche page index must be a non-negative integer, got ${pageIndex}`,
        );
    }
    if (!isPlainObject(page) || typeof page.dataUrl !== 'string' || typeof page.text !== 'string') {
        throw new TypeError('Microfiche stub page must carry a string dataUrl and string text');
    }
    stubPages.set(pageIndex, { dataUrl: page.dataUrl, text: page.text });
}

/**
 * Forget every staged stub page.
 * @returns {void}
 */
export function clearMicroficheStubPages() {
    stubPages.clear();
}

/**
 * Read one staged stub page without disturbing the registry.
 * @param {number} pageIndex - Zero-based page index.
 * @returns {{ dataUrl: string, text: string } | undefined} Staged page or undefined.
 */
export function resolveMicroficheStubPage(pageIndex) {
    return stubPages.get(pageIndex);
}

/**
 * Swap markers for text-plus-image parts. Strings become part arrays only
 * when at least one marker resolves; unknown markers stay plain text.
 * @param {unknown} content - String or OpenAI-style part array.
 * @param {(index: number) => ({ dataUrl: string, text: string } | undefined)} [resolvePage] - Page reader.
 * @returns {{ content: unknown, swapped: number }} Expanded content and swap count.
 */
export function expandMicroficheContent(content, resolvePage = resolveMicroficheStubPage) {
    if (typeof content === 'string') {
        return expandStringContent(content, resolvePage);
    }
    if (Array.isArray(content)) {
        return expandArrayContent(content, resolvePage);
    }
    return { content, swapped: 0 };
}

/**
 * Expand every marker-bearing message in place and count the swaps.
 * @param {Array<Record<string, unknown>>} chat - Mutable prompt-ready chat.
 * @param {(index: number) => ({ dataUrl: string, text: string } | undefined)} [resolvePage] - Page reader.
 * @returns {number} Resolved marker count; 0 leaves the payload untouched.
 */
export function expandMicrofichePromptChat(chat, resolvePage = resolveMicroficheStubPage) {
    if (!Array.isArray(chat) || !chat.every(isPlainObject)) {
        return 0;
    }
    let swapped = 0;
    for (const message of chat) {
        const expanded = expandMicroficheContent(message.content, resolvePage);
        if (expanded.swapped > 0) {
            message.content = expanded.content;
            swapped += expanded.swapped;
        }
    }
    return swapped;
}

/**
 * @param {string} text
 * @param {(index: number) => ({ dataUrl: string, text: string } | undefined)} resolvePage
 * @returns {{ content: unknown, swapped: number }}
 */
function expandStringContent(text, resolvePage) {
    const parts = [];
    let swapped = 0;
    let cursor = 0;
    for (const match of text.matchAll(MICROFICHE_MARKER_RE)) {
        const page = resolvePage(Number(match[1]));
        if (!page || typeof page.text !== 'string' || typeof page.dataUrl !== 'string') {
            continue;
        }
        const start = typeof match.index === 'number' ? match.index : cursor;
        pushTextPart(parts, text.slice(cursor, start));
        pushTextPart(parts, page.text);
        // OpenAI chat-compatible image part; the stub dataUrl stands in for
        // the real renderer output until that ticket lands.
        parts.push({ type: 'image_url', image_url: { url: page.dataUrl } });
        cursor = start + match[0].length;
        swapped += 1;
    }
    if (swapped === 0) {
        return { content: text, swapped: 0 };
    }
    pushTextPart(parts, text.slice(cursor));
    return { content: parts, swapped };
}

/**
 * @param {unknown[]} content
 * @param {(index: number) => ({ dataUrl: string, text: string } | undefined)} resolvePage
 * @returns {{ content: unknown, swapped: number }}
 */
function expandArrayContent(content, resolvePage) {
    const parts = [];
    let swapped = 0;
    for (const part of content) {
        if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
            const expanded = expandStringContent(part.text, resolvePage);
            if (expanded.swapped > 0 && Array.isArray(expanded.content)) {
                parts.push(...expanded.content);
                swapped += expanded.swapped;
                continue;
            }
        }
        parts.push(part);
    }
    return swapped === 0 ? { content, swapped: 0 } : { content: parts, swapped };
}

/**
 * @param {Array<Record<string, unknown>>} parts
 * @param {string} text
 * @returns {void}
 */
function pushTextPart(parts, text) {
    if (text !== '') {
        parts.push({ type: 'text', text });
    }
}
