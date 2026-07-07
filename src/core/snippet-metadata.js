import { parseSnippet } from './summarizer-state.js';

const UNKNOWN_TIME = 'unknown';
const LEADING_SNIPPET_ANCHOR_RE = /^\s*\[msgs\s+(?:unknown|\d+\s*-\s*\d+)(?:\s*;[^\]]*)?\]\s*/i;

/**
 * Build optional snippet metadata from a parsed [STATE] object.
 * @param {Record<string, string>} state
 * @returns {{ timelineStart?: string, timelineEnd?: string, currentDateTime?: string }}
 */
export function buildSnippetMetadataFromState(state = {}) {
    return compactMetadata({
        timelineStart: knownStateValue(state.timeline_start),
        timelineEnd: knownStateValue(state.timeline_end),
        currentDateTime: knownStateValue(state.current_date_time),
    });
}

/**
 * Build the metadata envelope for a promoted snippet.
 * @param {Array<object>} snippets
 * @returns {{ sourceRange?: [number, number], timelineStart?: string, timelineEnd?: string, currentDateTime?: string }}
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

    envelope.timelineStart = firstKnown(childMetadata.map((meta) => meta.timelineStart));
    envelope.timelineEnd = lastKnown(childMetadata.map((meta) => meta.timelineEnd));
    envelope.currentDateTime = lastKnown(childMetadata.map((meta) => meta.currentDateTime));
    return compactMetadata(envelope);
}

/**
 * Extract normalized optional chronology metadata from a snippet object.
 * @param {object} snippet
 * @returns {{ sourceRange?: [number, number], timelineStart?: string, timelineEnd?: string, currentDateTime?: string }}
 */
export function extractSnippetMetadata(snippet = {}) {
    return compactMetadata({
        sourceRange: normalizeRange(snippet.sourceRange),
        timelineStart: knownStateValue(snippet.timelineStart),
        timelineEnd: knownStateValue(snippet.timelineEnd),
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
    const hasRange = Boolean(meta.sourceRange);
    const hasTime = Boolean(meta.timelineStart || meta.timelineEnd || meta.currentDateTime);
    if (!hasRange && !hasTime) {
        return '';
    }

    const rangeText = meta.sourceRange
        ? `msgs ${meta.sourceRange[0]}-${meta.sourceRange[1]}`
        : 'msgs unknown';
    const start = meta.timelineStart || UNKNOWN_TIME;
    const end = meta.timelineEnd || UNKNOWN_TIME;
    return `[${rangeText}; ${start} -> ${end}]`;
}

/**
 * Strip a stored/generated leading chronology anchor from snippet prose.
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingSnippetAnchor(text) {
    return String(text || '')
        .replace(LEADING_SNIPPET_ANCHOR_RE, '')
        .trim();
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

function firstKnown(values) {
    return values.find(Boolean);
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
