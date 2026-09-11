import { getChat } from '../foundation/context.js';
import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import { parseSnippet } from './summarizer-state.js';
import { LEADING_NARRATIVE_HEADER_RE } from './structural-headers.js';

const UNKNOWN_TIME = 'unknown';
const COMPACT_CURRENT_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2})(?:\s+[a-z]{3})?$/i;
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
 * Build persisted metadata for a promoted snippet.
 * @param {Array<object>} snippets
 * @returns {{ sourceMessageIds: string[], currentDateTime?: string }}
 */
export function buildPromotedSnippetMetadata(snippets = []) {
    const sourceMessageIds = [];
    const seen = new Set();
    for (const snippet of snippets) {
        for (const id of snippet?.sourceMessageIds || []) {
            if (typeof id === 'string' && id.trim() !== '' && !seen.has(id)) {
                seen.add(id);
                sourceMessageIds.push(id);
            }
        }
    }
    const currentDateTime = lastKnown(
        snippets.map((snippet) => knownStateValue(snippet?.currentDateTime)),
    );
    return /** @type {{ sourceMessageIds: string[], currentDateTime?: string }} */ (
        compactMetadata({ sourceMessageIds, currentDateTime })
    );
}

/**
 * Extract persisted snippet metadata.
 * @param {object} snippet
 * @returns {{ sourceMessageIds: string[], currentDateTime?: string }}
 */
export function extractSnippetMetadata(snippet = {}) {
    return /** @type {{ sourceMessageIds: string[], currentDateTime?: string }} */ (
        compactMetadata({
            sourceMessageIds: Array.isArray(snippet.sourceMessageIds)
                ? [...snippet.sourceMessageIds]
                : [],
            currentDateTime: knownStateValue(snippet.currentDateTime),
        })
    );
}

/**
 * Format a snippet as anchored narrative for chronology or promotion input.
 * Parses the snippet, strips any stored leading anchor from the narrative when
 * an anchor was produced, and joins anchor + narrative with single spaces.
 * @param {object} snippet
 * @param {(snippet: object) => string} [formatAnchor] - Anchor formatter; defaults to the persisted anchor
 * @returns {string}
 */
export function formatAnchoredSnippetNarrative(snippet = {}, formatAnchor = formatSnippetAnchor) {
    const parsed = parseSnippet(snippet?.text || '');
    const anchor = formatAnchor(snippet);
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
    const range = resolveSnippetRange(meta.sourceMessageIds);
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
    const range = resolveSnippetRange(meta.sourceMessageIds);
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

function resolveSnippetRange(sourceMessageIds) {
    let chat;
    try {
        chat = getChat();
    } catch (_error) {
        return null;
    }
    const indices = resolveScIdsToIndices(chat, sourceMessageIds);
    if (indices.length === 0) {
        return null;
    }
    return [indices[0], indices[indices.length - 1]];
}

function knownStateValue(value) {
    const text = typeof value === 'string' ? value.trim() : '';
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
