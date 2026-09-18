import { getChat } from '../foundation/context.js';
import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import { collectSnippetSourceIds } from '../foundation/state.js';
import {
    LEADING_NARRATIVE_HEADER_RE,
    normalizeStructuralHeaderLines,
} from './structural-headers.js';

const UNKNOWN_TIME = 'unknown';
const COMPACT_CURRENT_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2})(?:\s+[a-z]{3})?$/i;
const LEADING_SNIPPET_ANCHORS_RE =
    /^\s*(?:(?:[-*]\s*)?\[msgs\s+(?:unknown|\d+\s*-\s*\d+)(?:\s*;[^\]]*)?\]\s*)+/i;
const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const CURRENT_DATE_TIME_RE =
    /^\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2})(?::\d{2})?)?(?:\s+([A-Za-z]{3}))?\s*$/;
const SCENE_TIME_LINE_RE = /^[^\S\r\n]*current_date_time[^\S\r\n]*[:=][^\S\r\n]*(.+)$/i;

/**
 * Parse a generated Layer 0 snippet into its narrative prose and scene time.
 * Narrative-only: a trailing `current_date_time:` key line is lifted out of
 * the prose and normalized; everything else stays narrative text.
 * @param {string} text
 * @returns {{ narrative: string, currentDateTime?: string }}
 */
export function parseSnippet(text) {
    const source = normalizeStructuralHeaderLines(text).trim();
    if (!source) {
        return { narrative: '', currentDateTime: undefined };
    }
    const body = source.replace(LEADING_NARRATIVE_HEADER_RE, '').trim();
    const lines = body.split(/\r?\n/);
    const sceneTimeMatch = SCENE_TIME_LINE_RE.exec(lines[lines.length - 1] || '');
    if (!sceneTimeMatch) {
        return { narrative: body, currentDateTime: undefined };
    }
    return {
        narrative: lines.slice(0, -1).join('\n').trimEnd(),
        currentDateTime: normalizeCurrentDateTime(sceneTimeMatch[1].trim()),
    };
}

/**
 * Derives the ISO weekday from the date and rewrites the value's
 * weekday token when it is missing or wrong. Preserves the hour and drops
 * stray minutes (per the HH-resolution contract). Returns the input verbatim
 * when no valid ISO date is present, so malformed values stay untouched.
 * @param {string} value - raw current_date_time value from the model
 * @returns {string}
 */
export function normalizeCurrentDateTime(value) {
    const text = String(value || '').trim();
    const match = text.match(CURRENT_DATE_TIME_RE);
    if (!match) {
        return text;
    }
    const [, yStr, mStr, dStr] = match;
    const year = Number(yStr);
    const month = Number(mStr);
    const day = Number(dStr);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return text;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        Number.isNaN(date.getTime()) ||
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return text;
    }
    const correctWeekday = WEEKDAY_NAMES[date.getUTCDay()];
    const normalizedHour = match[4] || '00';
    return `${yStr}-${mStr}-${dStr} ${normalizedHour} ${correctWeekday}`;
}

/**
 * Build optional snippet metadata from generated snippet text.
 * @param {string} text
 * @returns {{ currentDateTime?: string }}
 */
export function buildSnippetMetadataFromText(text) {
    return compactMetadata({
        currentDateTime: knownStateValue(parseSnippet(text).currentDateTime),
    });
}

/**
 * Build persisted metadata for a promoted snippet.
 * @param {Array<SummaryceptionSnippet>} snippets
 * @returns {{ sourceMessageIds: string[], currentDateTime?: string }}
 */
export function buildPromotedSnippetMetadata(snippets = []) {
    const sourceMessageIds = collectSnippetSourceIds([snippets]);
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
 * Derive structured display metadata for a snippet. Entry layers compose
 * user-facing strings from these fields. This module returns data only.
 * @param {object} snippet
 * @param {string[]} [snippet.sourceMessageIds] - Stable source message identifiers.
 * @param {number} [snippet.mergedCount] - How many child snippets were merged in.
 * @param {number} [snippet.fromLayer] - Layer the merged children came from.
 * @param {boolean} [snippet.promoted] - Whether promotion created this snippet.
 * @returns {{ sourceCount: number, mergedCount: number, fromLayer: number | undefined, promoted: boolean }}
 */
export function getSnippetDisplayMeta(snippet) {
    return {
        sourceCount: snippet.sourceMessageIds?.length || 0,
        mergedCount: snippet.mergedCount || 0,
        fromLayer: snippet.fromLayer,
        promoted: Boolean(snippet.promoted),
    };
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
