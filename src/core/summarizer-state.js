import { STATE_SNAPSHOT_COMPACTION_TARGET_CHARS } from '../foundation/prompt-constants.js';
import {
    LEADING_NARRATIVE_HEADER_RE,
    normalizeStructuralHeaderLines,
    STATE_HEADER_RE,
} from './structural-headers.js';

const STATE_LINE_RE = /^\s*[-*]?\s*([a-zA-Z_][\w\s]*?)\s*[:=-]\s*(.+?)\s*$/;
const ANY_SECTION_HEADER_RE = /^\s*\[[^\]]+\]\s*$/;
const NULLIFY_VALUES = new Set(['none', 'empty', 'null', 'cleared', 'resolved', 'removed']);
const IGNORED_STATE_KEYS = new Set(['timeline_start', 'timeline_end', 'start_time', 'end_time']);
const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const CURRENT_DATE_TIME_RE =
    /^\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2})(?::\d{2})?)?(?:\s+([A-Za-z]{3}))?\s*$/;
const UNCLASSIFIED_NOTES_MAX = 3;
const KEY_ALIASES = Object.freeze({
    location: 'location',
    place: 'location',
    current_place: 'location',
    current_location: 'location',
    where: 'location',
    room: 'location',
    area: 'location',
    bonds: 'bonds',
    bond: 'bonds',
    relationship: 'bonds',
    relationships: 'bonds',
    chekhov: 'chekhov',
    chechkov: 'chekhov',
    bullet: 'chekhov',
    bullets: 'chekhov',
    gun: 'chekhov',
    gm_notes: 'gm_notes',
    gmnote: 'gm_notes',
    gmnotebook: 'gm_notes',
    notebook: 'gm_notes',
    notes: 'gm_notes',
    inventory: 'inventory',
    inv: 'inventory',
    items: 'inventory',
    titles: 'inventory',
    current_date_time: 'current_date_time',
    current_datetime: 'current_date_time',
    current_time: 'current_date_time',
});
const SNAPSHOT_STATE_KEYS = Object.freeze([
    'current_date_time',
    'bonds',
    'chekhov',
    'gm_notes',
    'inventory',
    'location',
]);

// Per-category soft char budgets. Internal-only; never surfaced to the
// model. Bound each category's serialized length so one runaway category
// cannot monopolize the global budget. current_date_time is exempt from
// per-category trim (priorityRank -1 = carried verbatim). Sum ≈ 1780 chars
// (≈445 tokens) leaves headroom under the 1000-token hard cap for the [STATE]
// wrapper and key labels.
const STATE_CATEGORY_CHAR_BUDGET = Object.freeze({
    current_date_time: 200,
    bonds: 440,
    chekhov: 440,
    gm_notes: 340,
    inventory: 260,
    location: 100,
});

/**
 * Parse a stored snippet into narrative prose and structured state.
 * @param {string} text
 * @returns {{ narrative: string, state: Record<string, string> }}
 */
export function parseSnippet(text) {
    const source = normalizeStructuralHeaderLines(text).trim();
    if (!source) {
        return { narrative: '', state: {} };
    }

    const lines = source.split(/\r?\n/);
    const stateStart = lines.findIndex((line) => STATE_HEADER_RE.test(line));
    if (stateStart === -1) {
        return { narrative: stripNarrativeHeader(source), state: {} };
    }

    return {
        narrative: stripNarrativeHeader(lines.slice(0, stateStart).join('\n')),
        state: parseStateLines(extractExplicitStateLines(lines, stateStart)),
    };
}

/**
 * Parse text that may or may not carry a [STATE] header: prefix-wrap when the
 * header is missing, then parseSnippet. Single home of the wrap idiom used by
 * state compaction and the L0 source-state key count.
 * @param {string} text - State body or a complete [STATE] block
 * @returns {{ narrative: string, state: Record<string, string> }}
 */
export function parseStateBlock(text) {
    const source = String(text || '');
    return parseSnippet(/\[STATE\]/i.test(source) ? source : `[STATE]\n${source}`);
}
/**
 * Serialize state to the stored [STATE] block format.
 * @param {Record<string, string>} state
 * @returns {string}
 */
export function serializeState(state) {
    const lines = [];
    for (const [rawKey, rawValue] of Object.entries(state || {})) {
        const key = normalizeKey(rawKey);
        const value = normalizeSerializedStateValue(rawValue);
        if (IGNORED_STATE_KEYS.has(key) || !value || isNullifyValue(value)) {
            continue;
        }
        lines.push(`${key}: ${value}`);
    }
    return lines.length > 0 ? `[STATE]\n${lines.join('\n')}` : '';
}

/**
 * Normalize a generated state block to the bounded snapshot representation
 * used for current-state injection.
 * @param {string} stateText - State body or a complete [STATE] block
 * @returns {string} A compact [STATE] block, or an empty string when no state parses
 */
export function compactStateSnapshotText(stateText) {
    const source = String(stateText || '').trim();
    if (!source) {
        return '';
    }

    const parsed = parseStateBlock(source);
    if (Object.keys(parsed.state).length === 0) {
        return '';
    }

    return serializeState(compactSnapshotState(parsed.state));
}

/**
 * Read the latest Layer 0 rolling state snapshot.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {Record<string, string>}
 */
export function compileGlobalState(layers) {
    const layer = Array.isArray(layers?.[0]) ? layers[0] : [];
    const latestSnippet = layer.at(-1);
    return latestSnippet ? compactSnapshotState(parseSnippet(latestSnippet.text).state) : {};
}

function compactSnapshotState(state) {
    const compacted = /** @type {Record<string, string>} */ ({});
    let serializedLength = '[STATE]'.length;

    for (const key of SNAPSHOT_STATE_KEYS) {
        const value = normalizeSerializedStateValue(state?.[key]);
        if (!value || isNullifyValue(value)) {
            continue;
        }
        const prefixLength = 1 + key.length + 2;
        const remaining = STATE_SNAPSHOT_COMPACTION_TARGET_CHARS - serializedLength - prefixLength;
        if (remaining <= 0) {
            break;
        }

        // Per-category trim: hold each category under its own soft char cap so
        // one runaway category can't monopolize the global budget. Runs even
        // when the global budget is under-run (intentional: category bounding
        // is independent of global headroom). current_date_time is exempt
        // (priorityRank -1 = carried verbatim).
        let compactValue = value;
        const categoryCap = STATE_CATEGORY_CHAR_BUDGET[key];
        if (key !== 'current_date_time' && categoryCap && value.length > categoryCap) {
            compactValue = compactStateValueToLength(value, categoryCap);
        }
        // Global budget trim (still respected for every category).
        compactValue = compactStateValueToLength(compactValue, remaining);
        if (!compactValue) {
            continue;
        }
        compacted[key] = compactValue;
        serializedLength += prefixLength + compactValue.length;
    }

    return compacted;
}

function compactStateValueToLength(value, maxLength) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) {
        return text;
    }

    const entries = splitDelimitedEntries(text, /;/);
    if (entries.length > 1) {
        const kept = [];
        let length = 0;
        for (const entry of entries) {
            const addedLength = (kept.length > 0 ? 2 : 0) + entry.length;
            if (length + addedLength > maxLength) {
                break;
            }
            kept.push(entry);
            length += addedLength;
        }
        if (kept.length > 0) {
            return kept.join('; ');
        }
    }

    const clipped = text.slice(0, maxLength + 1);
    const boundary = clipped.lastIndexOf(' ');
    return clipped.slice(0, boundary > 0 ? boundary : maxLength).trim();
}

function extractExplicitStateLines(lines, stateStart) {
    const end = lines.findIndex(
        (line, index) => index > stateStart && ANY_SECTION_HEADER_RE.test(line),
    );
    return lines.slice(stateStart + 1, end === -1 ? undefined : end);
}

function parseStateLines(lines) {
    const state = /** @type {Record<string, string>} */ ({});
    const unclassified = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const match = trimmed.match(STATE_LINE_RE);
        if (!match) {
            unclassified.push(trimmed);
            continue;
        }
        const key = normalizeKey(match[1]);
        if (IGNORED_STATE_KEYS.has(key)) {
            continue;
        }
        const rawValue = match[2].trim();
        state[key] = key === 'current_date_time' ? normalizeCurrentDateTime(rawValue) : rawValue;
    }

    const notes = [...new Set(unclassified.map((note) => note.trim()).filter(Boolean))];
    if (notes.length > 0) {
        const capped = notes.slice(0, UNCLASSIFIED_NOTES_MAX).join('; ');
        state.unclassified_notes =
            notes.length > UNCLASSIFIED_NOTES_MAX ? `${capped} [...]` : capped;
    }
    return state;
}

/**
 * Correctly derives the ISO weekday from the date and rewrites the value's
 * weekday token when it is missing or wrong. Preserves the hour and drops
 * stray minutes (per the HH-resolution contract). Returns the input verbatim
 * when no valid ISO date is present, so malformed values stay untouched.
 * @param {string} value - raw current_date_time value from the model
 * @returns {string}
 */
function normalizeCurrentDateTime(value) {
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

function stripNarrativeHeader(text) {
    return String(text || '')
        .replace(LEADING_NARRATIVE_HEADER_RE, '')
        .trim();
}

function normalizeKey(rawKey) {
    const cleaned = String(rawKey || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
    if (KEY_ALIASES[cleaned]) {
        return KEY_ALIASES[cleaned];
    }

    const stripped = cleaned.replace(/^(current_|active_)/, '');
    return KEY_ALIASES[stripped] || cleaned;
}

function normalizeSerializedStateValue(rawValue) {
    const value = String(rawValue ?? '').trim();
    if (value.startsWith('{') && value.endsWith('}')) {
        return escapeStateValueQuotes(value.slice(1, -1).trim());
    }
    return escapeStateValueQuotes(value);
}

function isNullifyValue(value) {
    return NULLIFY_VALUES.has(
        String(value || '')
            .trim()
            .toLowerCase(),
    );
}

function splitDelimitedEntries(text, delimiter) {
    return text
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function escapeStateValueQuotes(value) {
    return String(value || '').replace(/(^|[^\\])"/g, '$1\\"');
}
