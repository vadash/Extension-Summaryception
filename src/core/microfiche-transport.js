import { isPlainObject } from '../foundation/objects.js';

// The marker never collides with story prose or the summarizer contract:
// structural headers use angle-bracket tags (<narrative>, <declined>) while
// this codec uses a square-bracket token with a summaryception-microfiche
// namespace that model prose never emits. The digit-only page slot keeps the
// scan one linear pass with no backtracking. The optional `:raw` suffix tags
// the frozen raw-chat region, so raw page 0 and memory page 0 stay separate
// index namespaces (ADR-0045).
const MICROFICHE_MARKER_RE = /\[summaryception-microfiche page=(\d+)(:raw)?\]/g;

/**
 * @typedef {'memory' | 'raw'} MicroficheRegion
 */

/**
 * Canonical spelling of one page region: the key used by page and stub maps,
 * the marker suffix that namespaces it, and the extra page-reader argument.
 * @typedef {object} MicroficheRegionSpec
 * @property {MicroficheRegion} key - Cache and plan-map key.
 * @property {string} suffix - Marker suffix for this region.
 * @property {MicroficheRegion | null} readerArg - Extra page-reader argument, when the region needs one.
 */

/** @type {Record<MicroficheRegion, MicroficheRegionSpec>} */
const MICROFICHE_REGIONS = {
    memory: { key: 'memory', suffix: '', readerArg: null },
    raw: { key: 'raw', suffix: ':raw', readerArg: 'raw' },
};

/**
 * Normalize any region label to its canonical spec. This is the one place
 * that decides what counts as raw.
 * @param {MicroficheRegion | null | undefined} [region] - Page region; memory by default.
 * @returns {MicroficheRegionSpec} Canonical region spec.
 */
export function resolveMicroficheRegion(region) {
    return region === 'raw' ? MICROFICHE_REGIONS.raw : MICROFICHE_REGIONS.memory;
}

/**
 * @typedef {object} MicroficheMarker
 * @property {number} pageIndex - Zero-based page index within the region.
 * @property {MicroficheRegion} region - Page region the marker names.
 */

const stubPages = new Map();

/**
 * Format the text-only slot marker for one microfiche page.
 * @param {number} pageIndex - Zero-based page index.
 * @param {MicroficheRegion} [region] - Page region; memory by default.
 * @returns {string} Single-line namespaced marker.
 */
export function formatMicroficheMarker(pageIndex, region = 'memory') {
    return formatRegionMarker(pageIndex, region);
}

/**
 * Format the text-only slot marker for one frozen raw-chat page. The `:raw`
 * suffix keeps its index namespace apart from memory pages.
 * @param {number} pageIndex - Zero-based page index.
 * @returns {string} Single-line namespaced marker.
 */
export function formatMicroficheRawMarker(pageIndex) {
    return formatRegionMarker(pageIndex, 'raw');
}

/**
 * @param {number} pageIndex - Zero-based page index.
 * @param {MicroficheRegion} region - Page region the marker names.
 * @returns {string} Single-line namespaced marker.
 */
function formatRegionMarker(pageIndex, region) {
    validatePageIndex(pageIndex);
    return `[summaryception-microfiche page=${pageIndex}${resolveMicroficheRegion(region).suffix}]`;
}

/**
 * List every marker in the text with its region.
 * @param {unknown} text - Candidate slot text.
 * @returns {MicroficheMarker[]} Markers in encounter order.
 */
export function extractMicroficheMarkers(text) {
    if (typeof text !== 'string') {
        return [];
    }
    /** @type {MicroficheMarker[]} */
    const markers = [];
    for (const match of text.matchAll(MICROFICHE_MARKER_RE)) {
        const pageIndex = Number(match[1]);
        if (Number.isSafeInteger(pageIndex)) {
            markers.push({ pageIndex, region: match[2] === ':raw' ? 'raw' : 'memory' });
        }
    }
    return markers;
}

/**
 * Stage one stub page for send-time expansion. Test and preview seam only;
 * the real renderer registers its own pages in a later ticket. Raw pages use
 * their own key space so a raw stub never resolves a memory page.
 * @param {number} pageIndex - Zero-based page index.
 * @param {{ dataUrl: string, text: string }} page - Stub image URL and page text.
 * @param {MicroficheRegion} [region] - Page region; memory by default.
 * @returns {void}
 */
export function registerMicroficheStubPage(pageIndex, page, region = 'memory') {
    validatePageIndex(pageIndex);
    if (!isPlainObject(page) || typeof page.dataUrl !== 'string' || typeof page.text !== 'string') {
        throw new TypeError('Microfiche stub page must carry a string dataUrl and string text');
    }
    stubPages.set(stubKey(pageIndex, region), { dataUrl: page.dataUrl, text: page.text });
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
 * @param {MicroficheRegion} [region] - Page region; memory by default.
 * @returns {{ dataUrl: string, text: string } | undefined} Staged page or undefined.
 */
export function resolveMicroficheStubPage(pageIndex, region = 'memory') {
    return stubPages.get(stubKey(pageIndex, region));
}

/**
 * @param {number} pageIndex - Zero-based page index.
 * @param {MicroficheRegion} region - Page region the stub names.
 * @returns {string} Cache key.
 */
function stubKey(pageIndex, region) {
    return `${resolveMicroficheRegion(region).key}:${pageIndex}`;
}

/**
 * @param {number} pageIndex - Candidate page index.
 * @returns {void}
 */
function validatePageIndex(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new RangeError(
            `Microfiche page index must be a non-negative integer, got ${pageIndex}`,
        );
    }
}

/**
 * Swap markers for image-only parts. Strings become part arrays only when at
 * least one marker resolves; unknown markers stay plain text. A resolved page
 * ships its image alone: the frozen page text never reaches the prompt, so the
 * page costs its image frame plus the real tail text only. Memory markers call
 * the reader with one argument; raw markers add `'raw'` so a memory-only reader
 * keeps its old contract.
 * @param {unknown} content - String or OpenAI-style part array.
 * @param {(index: number, region?: MicroficheRegion) => ({ dataUrl: string, text: string } | undefined)} [resolvePage] - Page reader.
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
 * Expand every marker-bearing message in place and count the swaps. In place
 * means the chat array and its message objects keep their positions: only
 * `content` is replaced, because the wire order built upstream is the
 * chronological order the model must receive.
 * @param {Array<Record<string, unknown>>} chat - Mutable prompt-ready chat.
 * @param {(index: number, region?: MicroficheRegion) => ({ dataUrl: string, text: string } | undefined)} [resolvePage] - Page reader.
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
 * @param {(index: number, region?: MicroficheRegion) => ({ dataUrl: string, text: string } | undefined)} resolvePage
 * @returns {{ content: unknown, swapped: number }}
 */
function expandStringContent(text, resolvePage) {
    const parts = [];
    let swapped = 0;
    let cursor = 0;
    for (const match of text.matchAll(MICROFICHE_MARKER_RE)) {
        const pageIndex = Number(match[1]);
        const spec = resolveMicroficheRegion(match[2] === ':raw' ? 'raw' : 'memory');
        const page =
            spec.readerArg === null
                ? resolvePage(pageIndex)
                : resolvePage(pageIndex, spec.readerArg);
        if (!page || typeof page.text !== 'string' || typeof page.dataUrl !== 'string') {
            continue;
        }
        const start = typeof match.index === 'number' ? match.index : cursor;
        pushTextPart(parts, text.slice(cursor, start));
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
 * @param {(index: number, region?: MicroficheRegion) => ({ dataUrl: string, text: string } | undefined)} resolvePage
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
