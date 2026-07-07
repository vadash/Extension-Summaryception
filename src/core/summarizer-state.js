const STATE_LINE_RE = /^\s*[-*]?\s*([a-zA-Z_][\w\s]*?)\s*[:=-]\s*(.+?)\s*$/;
const STATE_HEADER_RE = /^\s*\[STATE\]\s*$/i;
const NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*$/i;
const ANY_SECTION_HEADER_RE = /^\s*\[[^\]]+\]\s*$/;
const NULLIFY_VALUES = new Set(['none', 'empty', 'null', 'cleared', 'resolved', 'removed']);
const UNCLASSIFIED_NOTES_MAX = 3;
const STATE_ENTRY_LIMIT = 10;
const STATE_VALUE_LENGTH_CEILING = 1000;
const STALE_TRANSIENT_LAYER_MIN = 2;
const COMPOSITE_MERGE_KEYS = new Set(['characters', 'inventory', 'counters', 'dynamics']);
const COMPOSITE_ENTRY_RE = /^([a-zA-Z0-9 _-]+?)\s*[:=]\s*(.+)$/;
const STATIC_PROFILE_KEY_PARTS = [
    'origin',
    'hometown',
    'backstory',
    'personality',
    'species',
    'nationality',
];
const TRANSIENT_KEY_RE =
    /(^|_)(clothing|clothes|outfit|wearing|mood|arousal|soreness|fatigue|scene|pose|position|active|temporary|temp|current)(_|$)/;

const KEY_ALIASES = Object.freeze({
    location: 'location',
    place: 'location',
    current_place: 'location',
    current_location: 'location',
    where: 'location',
    room: 'location',
    area: 'location',
    characters: 'characters',
    people: 'characters',
    npcs: 'characters',
    who: 'characters',
    inventory: 'inventory',
    items: 'inventory',
    equipment: 'inventory',
    toys: 'inventory',
    gear: 'inventory',
    dynamics: 'dynamics',
    relationship: 'dynamics',
    power: 'dynamics',
    roles: 'dynamics',
    hooks: 'hooks',
    plans: 'hooks',
    goals: 'hooks',
    threads: 'hooks',
    unresolved: 'hooks',
    counters: 'counters',
    tally: 'counters',
    tallies: 'counters',
    counts: 'counters',
    score: 'counters',
});
const CANONICAL_STATE_KEYS = new Set(Object.values(KEY_ALIASES));

/**
 * Check whether text contains an explicit [STATE] section.
 * @param {string} text
 * @returns {boolean}
 */
export function hasStateSection(text) {
    return String(text || '')
        .split(/\r?\n/)
        .some((line) => STATE_HEADER_RE.test(line));
}

/**
 * Parse a stored snippet into narrative prose and structured state.
 * @param {string} text
 * @returns {{ narrative: string, state: Record<string, string> }}
 */
export function parseSnippet(text) {
    const source = String(text || '').trim();
    if (!source) {
        return { narrative: '', state: {} };
    }

    const lines = source.split(/\r?\n/);
    const explicitStateStart = findHeaderLine(lines, STATE_HEADER_RE);
    const stateStart =
        explicitStateStart === -1 ? findImplicitStateBoundary(lines) : explicitStateStart;
    if (stateStart === -1) {
        return { narrative: stripNarrativeHeader(source), state: {} };
    }

    const narrativeLines = extractNarrativeLines(lines, stateStart);
    const stateLines =
        explicitStateStart === -1
            ? extractImplicitStateLines(lines, stateStart)
            : extractExplicitStateLines(lines, stateStart);
    return {
        narrative: stripNarrativeHeader(narrativeLines.join('\n').trim()),
        state: parseStateLines(stateLines),
    };
}

/**
 * Merge state objects oldest-to-newest. Later values overwrite earlier ones.
 * @param {Array<Record<string, string>>} states
 * @returns {Record<string, string>}
 */
export function mergeStates(states) {
    const merged = /** @type {Record<string, string>} */ ({});
    const allUnclassified = [];

    for (const state of states || []) {
        mergeStateInto(merged, allUnclassified, state);
    }

    applyUnclassifiedNotes(merged, allUnclassified);
    return merged;
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
        if (!value || isNullifyValue(value)) {
            continue;
        }
        lines.push(`${key}: ${value}`);
    }
    return lines.length > 0 ? `[STATE]\n${lines.join('\n')}` : '';
}

/**
 * Compile all layer snippets into one merged state object.
 * @param {Array<Array<{ text: string }>>} layers
 * @returns {Record<string, string>}
 */
export function compileGlobalState(layers) {
    const compiled = /** @type {Record<string, string>} */ ({});
    const allUnclassified = [];
    const keyLastLayer = new Map();

    for (let i = (layers || []).length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!Array.isArray(layer)) {
            continue;
        }
        for (const snippet of layer) {
            const parsed = parseSnippet(snippet?.text || '');
            if (Object.keys(parsed.state).length > 0) {
                mergeStateInto(compiled, allUnclassified, parsed.state, {
                    filterStaticProfile: true,
                    keyLastLayer,
                    layerIndex: i,
                });
            }
        }
    }

    pruneStaleTransientState(compiled, keyLastLayer);
    applyUnclassifiedNotes(compiled, allUnclassified);
    return compiled;
}

function findHeaderLine(lines, regex) {
    return lines.findIndex((line) => regex.test(line));
}

function findImplicitStateBoundary(lines) {
    let boundary = -1;
    let matchCount = 0;
    let recognizedCount = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) {
            continue;
        }

        const match = trimmed.match(STATE_LINE_RE);
        if (!match) {
            break;
        }

        boundary = i;
        matchCount++;
        if (isCanonicalStateKey(match[1])) {
            recognizedCount++;
        }
    }

    if (!isPlausibleImplicitStateBlock({ boundary, matchCount, recognizedCount })) {
        return -1;
    }
    return boundary;
}

function isPlausibleImplicitStateBlock({ boundary, matchCount, recognizedCount }) {
    if (boundary === -1 || matchCount === 0 || recognizedCount === 0) {
        return false;
    }
    if (matchCount >= 2) {
        return true;
    }
    return boundary > 0 && recognizedCount > 0;
}

function isCanonicalStateKey(rawKey) {
    return CANONICAL_STATE_KEYS.has(normalizeKey(rawKey));
}

function extractNarrativeLines(lines, stateStart) {
    const narrativeStart = findHeaderLine(lines, NARRATIVE_HEADER_RE);
    if (narrativeStart !== -1 && narrativeStart < stateStart) {
        return lines.slice(narrativeStart + 1, stateStart);
    }
    return lines.slice(0, stateStart);
}

function extractExplicitStateLines(lines, stateStart) {
    const end = lines.findIndex(
        (line, index) => index > stateStart && ANY_SECTION_HEADER_RE.test(line),
    );
    return lines.slice(stateStart + 1, end === -1 ? undefined : end);
}

function extractImplicitStateLines(lines, stateStart) {
    return lines.slice(stateStart);
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
        state[normalizeKey(match[1])] = match[2].trim();
    }

    const notes = dedupeNotes(unclassified);
    if (notes.length > 0) {
        state.unclassified_notes = formatCappedNotes(notes);
    }
    return state;
}

function stripNarrativeHeader(text) {
    return String(text || '')
        .replace(/^\s*\[NARRATIVE\]\s*/i, '')
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

function mergeStateInto(merged, allUnclassified, state, options = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return;
    }

    for (const [rawKey, rawValue] of Object.entries(state)) {
        mergeStateEntry(merged, allUnclassified, rawKey, rawValue, options);
    }
}

function mergeStateEntry(merged, allUnclassified, rawKey, rawValue, options) {
    const key = normalizeKey(rawKey);
    const value = String(rawValue ?? '').trim();
    if (!value) {
        return;
    }
    if (key === 'unclassified_notes') {
        allUnclassified.push(...splitUnclassifiedNotes(value));
        return;
    }
    if (options.filterStaticProfile && isStaticProfileKey(key)) {
        return;
    }
    if (isNullifyValue(value)) {
        deleteTrackedStateKey(merged, key, options);
        return;
    }

    const prunedValue = pruneMergedStateValue(value);
    if (!prunedValue) {
        return;
    }
    if (isNullifyValue(prunedValue)) {
        deleteTrackedStateKey(merged, key, options);
        return;
    }
    if (COMPOSITE_MERGE_KEYS.has(key)) {
        merged[key] = mergeCompositeValue(merged[key], prunedValue);
    } else {
        merged[key] = prunedValue;
    }
    trackStateKeyLayer(key, options);
}

function deleteTrackedStateKey(merged, key, options) {
    delete merged[key];
    options.keyLastLayer?.delete(key);
}

/**
 * Merge two composite semicolon-delimited values preserving older sub-entries
 * that are not reasserted in the newer value. Falls back to whole-value
 * overwrite when either value is not structured composite text.
 * @param {string|undefined} oldVal
 * @param {string} newVal
 * @returns {string}
 */
function mergeCompositeValue(oldVal, newVal) {
    if (!oldVal) {
        return newVal;
    }
    const oldEntries = parseCompositeEntries(oldVal);
    const newEntries = parseCompositeEntries(newVal);
    if (!oldEntries || !newEntries) {
        return newVal;
    }
    const combined = new Map();
    for (const { key, value } of oldEntries) {
        combined.set(key.toLowerCase(), { key, value });
    }
    for (const { key, value } of newEntries) {
        const normalized = key.toLowerCase();
        if (isNullifyValue(value)) {
            combined.delete(normalized);
        } else {
            combined.set(normalized, { key, value });
        }
    }
    const serialized = [...combined.values()]
        .map(({ key, value }) => `${key}: ${value}`)
        .join('; ');
    return pruneMergedStateValue(serialized) || serialized;
}

/**
 * Parse a semicolon-delimited composite value into an ordered list of
 * sub-key/value pairs. Returns null when the value is not structured
 * composite text.
 * @param {string} value
 * @returns {Array<{key: string, value: string}>|null}
 */
function parseCompositeEntries(value) {
    const text = String(value || '').trim();
    if (!text || !text.includes(':')) {
        return null;
    }
    const entries = splitDelimitedEntries(text, /;/);
    if (entries.length === 0) {
        return null;
    }
    const parsed = [];
    for (const entry of entries) {
        const match = entry.match(COMPOSITE_ENTRY_RE);
        if (!match) {
            return null;
        }
        parsed.push({ key: match[1].trim(), value: match[2].trim() });
    }
    return parsed;
}

function trackStateKeyLayer(key, options) {
    if (Number.isInteger(options.layerIndex)) {
        options.keyLastLayer?.set(key, options.layerIndex);
    }
}

function applyUnclassifiedNotes(merged, allUnclassified) {
    const notes = dedupeNotes(allUnclassified);
    if (notes.length > 0) {
        merged.unclassified_notes = formatCappedNotes(notes);
    }
}

function pruneStaleTransientState(compiled, keyLastLayer) {
    for (const key of Object.keys(compiled)) {
        const lastLayer = keyLastLayer.get(key);
        if (lastLayer >= STALE_TRANSIENT_LAYER_MIN && isTransientStateKey(key)) {
            delete compiled[key];
        }
    }
}

function isStaticProfileKey(key) {
    if (key === 'age' || key.endsWith('_age')) {
        return true;
    }
    return STATIC_PROFILE_KEY_PARTS.some(
        (part) => key === part || key.includes(`_${part}`) || key.includes(`${part}_`),
    );
}

function isTransientStateKey(key) {
    return key === 'location' || key === 'characters' || TRANSIENT_KEY_RE.test(key);
}

function splitUnclassifiedNotes(value) {
    return String(value || '')
        .replace(/\s+\[\.\.\.\]\s*$/, '')
        .split(';')
        .map((note) => note.trim())
        .filter(Boolean);
}

function dedupeNotes(notes) {
    return [...new Set(notes.map((note) => note.trim()).filter(Boolean))];
}

function formatCappedNotes(notes) {
    const capped = notes.slice(0, UNCLASSIFIED_NOTES_MAX).join('; ');
    return notes.length > UNCLASSIFIED_NOTES_MAX ? `${capped} [...]` : capped;
}

function pruneMergedStateValue(value) {
    return pruneSemicolonStateEntries(value);
}

function pruneSemicolonStateEntries(value) {
    const text = String(value || '').trim();
    if (!text || !text.includes(';')) {
        return value;
    }

    const entries = splitDelimitedEntries(text, /;/);
    if (entries.length <= STATE_ENTRY_LIMIT && text.length <= STATE_VALUE_LENGTH_CEILING) {
        return value;
    }

    return entries.slice(-STATE_ENTRY_LIMIT).join('; ');
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
