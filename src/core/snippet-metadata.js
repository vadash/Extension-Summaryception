import { parseSnippet } from './summarizer-state.js';

const UNKNOWN_TIME = 'unknown';
const COMPACT_CURRENT_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2})(?:\s+[a-z]{3})?$/i;
const LEADING_NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*/i;
const LEADING_SNIPPET_ANCHORS_RE =
    /^\s*(?:(?:[-*]\s*)?\[msgs\s+(?:unknown|\d+\s*-\s*\d+)(?:\s*;[^\]]*)?\]\s*)+/i;

/**
 * Build optional snippet metadata from a parsed [STATE] object.
 * @param {Record<string, string>} state
 * @returns {{ currentDateTime?: string }}
 */
export function buildSnippetMetadataFromState(state = {}) {
    return compactMetadata({
        currentDateTime: knownStateValue(state.current_date_time),
    });
}

/**
 * Build the metadata envelope for a promoted snippet.
 * @param {Array<object>} snippets
 * @returns {{ sourceRange?: [number, number], currentDateTime?: string }}
 */
export function buildPromotedSnippetMetadata(snippets = []) {
    const childMetadata = snippets.map(extractSnippetMetadata);
    const ranges = [];
    for (const meta of childMetadata) {
        if (meta.sourceRange) {
            ranges.push(meta.sourceRange);
        }
    }
    const envelope = {};

    if (ranges.length > 0) {
        envelope.sourceRange = [
            Math.min(...ranges.map((range) => range[0])),
            Math.max(...ranges.map((range) => range[1])),
        ];
    }

    envelope.currentDateTime = lastKnown(childMetadata.map((meta) => meta.currentDateTime));
    return compactMetadata(envelope);
}

/**
 * Extract normalized optional chronology metadata from a snippet object.
 * @param {object} snippet
 * @returns {{ sourceRange?: [number, number], currentDateTime?: string }}
 */
export function extractSnippetMetadata(snippet = {}) {
    return compactMetadata({
        sourceRange: normalizeRange(snippet.sourceRange),
        currentDateTime: knownStateValue(snippet.currentDateTime),
    });
}

/**
 * Format a snippet as anchored narrative for chronology or promotion input.
 * @param {object} snippet
 * @returns {string}
 */
export function formatAnchoredSnippetNarrative(snippet = {}) {
    const parsed = parseSnippet(snippet?.text || '');
    const anchor = formatSnippetAnchor(snippet);
    const narrative = anchor
        ? stripLeadingSnippetAnchor(parsed.narrative)
        : parsed.narrative.trim();
    return [anchor, narrative].filter(Boolean).join(' ');
}

/**
 * Format the deterministic source/time anchor for a snippet.
 * @param {object} snippet
 * @returns {string}
 */
export function formatSnippetAnchor(snippet = {}) {
    const meta = extractSnippetMetadata(snippet);
    const range = meta.sourceRange;
    if (!range) {
        return '';
    }

    const rangeText = `msgs ${range[0]}-${range[1]}`;
    const current = meta.currentDateTime || UNKNOWN_TIME;
    return `[${rangeText}; current ${current}]`;
}

/**
 * Format a compact source/time anchor for runtime memory injection.
 * @param {object} snippet
 * @returns {string}
 */
export function formatCompactSnippetAnchor(snippet = {}) {
    const meta = extractSnippetMetadata(snippet);
    const range = meta.sourceRange;
    if (!range) {
        return '';
    }

    const rangeText = `${range[0]}-${range[1]}`;
    const current = formatCompactCurrentDateTime(meta.currentDateTime);
    return current ? `[${rangeText}@${current}]` : `[${rangeText}]`;
}

/**
 * Strip a stored/generated leading chronology anchor from snippet prose.
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingSnippetAnchor(text) {
    let cleaned = String(text || '')
        .replace(LEADING_NARRATIVE_HEADER_RE, '')
        .trim();
    while (LEADING_SNIPPET_ANCHORS_RE.test(cleaned)) {
        cleaned = cleaned.replace(LEADING_SNIPPET_ANCHORS_RE, '').trim();
    }
    return cleaned;
}

function normalizeRange(range) {
    if (
        !Array.isArray(range) ||
        range.length < 2 ||
        !Number.isInteger(range[0]) ||
        !Number.isInteger(range[1]) ||
        range[0] < 0 ||
        range[1] < range[0]
    ) {
        return undefined;
    }
    return [range[0], range[1]];
}

function knownStateValue(value) {
    const text = String(value ?? '').trim();
    if (!text || text.toLowerCase() === UNKNOWN_TIME) {
        return undefined;
    }
    return text;
}

function formatCompactCurrentDateTime(value) {
    const current = knownStateValue(value);
    if (!current) {
        return '';
    }
    const match = COMPACT_CURRENT_DATE_TIME_RE.exec(current);
    return match ? `${match[1]}T${match[2]}` : current;
}

function lastKnown(values) {
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i]) {
            return values[i];
        }
    }
    return undefined;
}

function compactMetadata(metadata) {
    return Object.fromEntries(
        Object.entries(metadata).filter(([, value]) => value !== undefined && value !== ''),
    );
}
