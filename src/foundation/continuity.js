import { clampInteger } from './numeric.js';
import { getMessageIndexByScId } from './message-identity.js';

const BOND_BOUNDS = Object.freeze({ bond: [-5, 20], sparks: [0, 99], grudge: [0, 99] });
const STEP_CEILING = 99;
const GM_NOTE_TOTAL_CAP = 20;
const GM_NOTE_KIND_CAP = 10;
const NOTE_TAG_PATTERN = /^\[([RTS])\]/u;
const USER_PAIR_PATTERN = /.+↔User$/u;
const PHYSICS_FIELDS = Object.freeze([
    'location',
    'environment',
    'posture_and_position',
    'contact_points',
    'clothing_state',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Agenda and bond text fields degrade to their schema defaults rather than
 * verdicts: only missing sections, unknown pair keys, and unknown note tags
 * are section-repair worthy.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTextField(value) {
    return typeof value === 'string' ? value : 'None';
}

/**
 * A pair absent from prior state (first appearance in an audit) seeds at
 * neutral zero, not the bond clamp floor; existing records still clamp each
 * field into the schema ranges.
 * @param {unknown} value
 * @returns {SummaryceptionContinuityBond}
 */
function normalizeBondPair(value) {
    if (!isRecord(value)) {
        return { bond: 0, sparks: 0, grudge: 0 };
    }
    return {
        bond: clampInteger(value.bond, BOND_BOUNDS.bond[0], BOND_BOUNDS.bond[1]),
        sparks: clampInteger(value.sparks, BOND_BOUNDS.sparks[0], BOND_BOUNDS.sparks[1]),
        grudge: clampInteger(value.grudge, BOND_BOUNDS.grudge[0], BOND_BOUNDS.grudge[1]),
    };
}

/**
 * Canonical bond pair key is `Name↔User`; stored state and Auditor output can
 * drift in surrounding whitespace or operand order, and both drift forms must
 * fold onto one record instead of splitting or dropping the pair.
 * @param {unknown} key
 * @returns {string | null} `Name↔User`, or null when there is no `↔`
 *   separator or neither operand is exactly `User`.
 */
export function canonicalizePairKey(key) {
    if (typeof key !== 'string') {
        return null;
    }
    const [left, right] = key.trim().split(/\s*↔\s*/u);
    if (right === 'User') {
        return `${left}↔User`;
    }
    if (left === 'User') {
        return `${right}↔User`;
    }
    return null;
}

/**
 * Step invariant 1 ≤ current ≤ max ≤ 99: clamp max first, then clamp current
 * against the clamped max.
 * @param {unknown} value
 * @returns {SummaryceptionAgenda}
 */
function normalizeAgenda(value) {
    const source = isRecord(value) ? value : {};
    const step = isRecord(source.step) ? source.step : {};
    const max = clampInteger(step.max, 1, STEP_CEILING);
    return {
        task: normalizeTextField(source.task),
        step: { current: clampInteger(step.current, 1, max), max },
        status: normalizeTextField(source.status),
        body_state: normalizeTextField(source.body_state),
        fibs: normalizeTextField(source.fibs),
        aware: normalizeTextField(source.aware),
    };
}

/**
 * Keeps only tagged strings in order, truncating per kind and then total; the
 * Auditor orders notes by priority, so first-seen wins.
 * @param {unknown[]} notes
 * @returns {{ kept: string[], unknownTag: boolean }}
 */
function filterGmNotes(notes) {
    const kept = [];
    const perKind = { R: 0, T: 0, S: 0 };
    let unknownTag = false;
    for (const entry of notes) {
        const note = typeof entry === 'string' ? entry : null;
        const match = note !== null ? note.match(NOTE_TAG_PATTERN) : null;
        if (note === null || !match) {
            unknownTag = true;
            continue;
        }
        if (perKind[match[1]] >= GM_NOTE_KIND_CAP) {
            continue;
        }
        perKind[match[1]] += 1;
        if (kept.length < GM_NOTE_TOTAL_CAP) {
            kept.push(note);
        }
    }
    return { kept, unknownTag };
}

/**
 * @param {unknown} value
 * @returns {SummaryceptionContinuityPhysics}
 */
function normalizePhysics(value) {
    const source = isRecord(value) ? value : {};
    const physics = /** @type {SummaryceptionContinuityPhysics} */ ({});
    for (const field of PHYSICS_FIELDS) {
        physics[field] = typeof source[field] === 'string' ? source[field] : '';
    }
    return physics;
}

/**
 * @returns {SummaryceptionContinuityState}
 */
export function createDefaultContinuity() {
    return {
        turn_count: 0,
        bonds: {},
        agendas: {},
        gm_notes: [],
        physics: {
            location: '',
            environment: '',
            posture_and_position: '',
            contact_points: '',
            clothing_state: '',
        },
    };
}

/**
 * Merge raw bond pairs into the state and mirror the raw payloads into flags.
 * @param {Record<string, unknown>} source - Raw parsed Auditor object.
 * @param {SummaryceptionContinuityState} state - State under construction.
 * @param {string[]} sectionVerdicts - Section verdict sink.
 * @returns {Record<string, Record<string, unknown>>} Raw per-pair bond payloads (record values only).
 */
function classifyBonds(source, state, sectionVerdicts) {
    /** @type {Record<string, Record<string, unknown>>} */
    const flags = {};
    if (!isRecord(source.bonds)) {
        sectionVerdicts.push('bonds');
        return flags;
    }
    let unknownPair = false;
    for (const [key, value] of Object.entries(source.bonds)) {
        const canonical = canonicalizePairKey(key);
        const known = canonical !== null && USER_PAIR_PATTERN.test(canonical);
        const pairKey = known ? /** @type {string} */ (canonical) : key;
        unknownPair = unknownPair || !known;
        state.bonds[pairKey] = normalizeBondPair(value);
        if (isRecord(value)) {
            flags[pairKey] = value;
        }
    }
    if (unknownPair) {
        sectionVerdicts.push('bonds');
    }
    return flags;
}

/**
 * Classify raw Auditor JSON against the v1 continuity schema without merging
 * into prior state: section verdicts drive the caller's repair retry.
 * Field damage is clamped into the returned state; missing sections, an
 * unknown pair key, or an unknown note tag produce a section verdict.
 * The returned flags mirror the raw per-pair bond payloads (record values
 * only) before numeric normalization, so the rulebook can read what the
 * Auditor actually said.
 * @param {string | unknown} raw - Raw JSON text or an already-parsed value.
 * @returns {{ state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>> }}
 */
export function classifyContinuity(raw) {
    let parsed;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return { state: null, sectionVerdicts: ['parse'], flags: {} };
    }
    const source = isRecord(parsed) ? parsed : {};
    const state = createDefaultContinuity();
    const sectionVerdicts = [];
    const flags = classifyBonds(source, state, sectionVerdicts);

    if (source.turn_count === undefined) {
        sectionVerdicts.push('turn_count');
    } else {
        state.turn_count = clampInteger(source.turn_count, 0, Number.MAX_SAFE_INTEGER);
    }

    if (isRecord(source.agendas)) {
        for (const [key, value] of Object.entries(source.agendas)) {
            state.agendas[key] = normalizeAgenda(value);
        }
    } else {
        sectionVerdicts.push('agendas');
    }

    if (Array.isArray(source.gm_notes)) {
        const { kept, unknownTag } = filterGmNotes(source.gm_notes);
        state.gm_notes = kept;
        if (unknownTag) {
            sectionVerdicts.push('gm_notes');
        }
    } else {
        sectionVerdicts.push('gm_notes');
    }

    if (isRecord(source.physics)) {
        state.physics = normalizePhysics(source.physics);
    } else {
        sectionVerdicts.push('physics');
    }

    return { state, sectionVerdicts, flags };
}

/**
 * The Auditor orders per-pair booleans only; this module is the sole writer
 * of bond/sparks/grudge (issue #28 flags rulebook). Decay runs before the
 * sparks conversion so a decayed counter must re-reach 7 before converting.
 * @param {SummaryceptionContinuityBond} pair - Prior counters; never mutated.
 * @param {Partial<SummaryceptionContinuityFlags>} flags - Per-pair Auditor booleans; absent means false.
 * @param {number} turnCount - Derived turn number driving the %3 / %5 conversions.
 * @returns {SummaryceptionContinuityBond} New pair object clamped into schema ranges.
 */
export function applyPairFlags(pair, flags, turnCount) {
    const next = normalizeBondPair(pair);
    const source = isRecord(flags) ? flags : {};

    if (source.positive_interaction === true) {
        next.sparks += 1;
    }
    if (source.slight === true) {
        next.grudge += 1;
    }
    if (source.insult === true) {
        next.bond -= 1;
    }
    if (source.betrayal === true) {
        next.bond -= 2;
    }
    if (source.apology === true) {
        next.grudge = 0;
    }

    if (turnCount % 5 === 0) {
        if (source.positive_interaction !== true) {
            next.sparks = Math.max(0, next.sparks - 1);
        }
        if (next.sparks >= 7) {
            // Grudge 3+ dulls the gain to zero; the sparks are still spent.
            next.bond += next.grudge >= 3 ? 0 : 1;
            next.sparks = 0;
        }
    }

    if (turnCount % 3 === 0) {
        if (next.grudge >= 5) {
            next.bond -= 1;
            next.grudge = 0;
        } else {
            next.grudge = Math.max(0, next.grudge - 1);
        }
    }

    next.bond = clampInteger(next.bond, BOND_BOUNDS.bond[0], BOND_BOUNDS.bond[1]);
    next.sparks = clampInteger(next.sparks, BOND_BOUNDS.sparks[0], BOND_BOUNDS.sparks[1]);
    next.grudge = clampInteger(next.grudge, BOND_BOUNDS.grudge[0], BOND_BOUNDS.grudge[1]);
    return next;
}

/**
 * Chat indices of assistant messages strictly after the anchor sc_id, or null
 * when a non-empty anchor is missing from the chat. Identity-based on purpose:
 * swipes, continues, deletions, and forks all break index math, and every
 * consumer (turn counting, audit coverage, anchor re-pointing) must walk the
 * same range so the %3 / %5 conversions stay phase-sensitive.
 * @param {ChatMessage[] | unknown} chat
 * @param {string} anchorScId - '' selects the whole chat.
 * @returns {number[] | null}
 */
export function listAssistantIndicesAfter(chat, anchorScId) {
    const messages = Array.isArray(chat) ? chat : [];
    let startIndex = 0;
    if (anchorScId) {
        const anchorIndex = getMessageIndexByScId(messages).get(anchorScId);
        if (anchorIndex === undefined) {
            return null;
        }
        startIndex = anchorIndex + 1;
    }
    const indices = [];
    for (let index = startIndex; index < messages.length; index++) {
        const message = messages[index];
        if (message && !message.is_user && !message.is_system) {
            indices.push(index);
        }
    }
    return indices;
}

/**
 * Count every assistant message in the chat; the Turn Count re-derives from
 * the chat start at every audit.
 * @param {ChatMessage[] | unknown} chat
 * @returns {number}
 */
export function deriveTurnCount(chat) {
    const indices = listAssistantIndicesAfter(chat, '');
    return indices === null ? 0 : indices.length;
}

/**
 * FNV-1a 32-bit hash of the message body as 8 hex chars. Checkpoint payloads
 * store it so a swiped, edited, or regenerated variation invalidates its own
 * checkpoint; code-unit iteration keeps the value stable across engines.
 * @param {unknown} mes
 * @returns {string}
 */
export function hashMessageText(mes) {
    const text = String(mes ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A checkpoint counts only when the payload is well-formed, belongs to the
 * carrying message, and still hashes against the reply's current text.
 * @param {ChatMessage} message
 * @param {unknown} payload
 * @returns {boolean}
 */
function isValidCheckpoint(message, payload) {
    return (
        isRecord(payload) &&
        typeof payload.audited_sc_id === 'string' &&
        payload.audited_sc_id !== '' &&
        payload.audited_sc_id === message.sc_id &&
        typeof payload.text_hash === 'string' &&
        isRecord(payload.state) &&
        hashMessageText(message.mes) === payload.text_hash
    );
}

/**
 * Walk the chat ascending and return the newest Continuity Checkpoint whose
 * chain is intact and whose index sits strictly before the most recent user
 * message (ADR-0011): every earlier checkpoint must count too, so the first
 * malformed, re-targeted, or text-changed checkpoint drops the read model
 * back to the previous one (ADR-0010). A post-user checkpoint is out of the
 * read model, never a broken link. Messages without a payload are not links
 * and never break the chain. No user message in the chat means no bound and
 * the newest valid checkpoint wins.
 * @param {ChatMessage[] | unknown} chat
 * @returns {{ state: SummaryceptionContinuityState, message: ChatMessage, index: number } | null}
 */
export function findLiveCheckpoint(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.is_user) {
            lastUserIndex = index;
            break;
        }
    }
    let live = null;
    for (let index = 0; index < messages.length; index++) {
        // Checkpoints at or after the last user message are discarded-draft
        // state; stop before validating them so they cannot break the chain.
        if (index === lastUserIndex) {
            break;
        }
        const message = messages[index];
        const payload = message?.extra?.summaryception_continuity;
        if (payload === undefined) {
            continue;
        }
        if (!isValidCheckpoint(message, payload)) {
            break;
        }
        live = {
            state: /** @type {SummaryceptionContinuityState} */ (payload.state),
            message,
            index,
        };
    }
    return live;
}

const GATE_LADDER = Object.freeze([
    { minBond: 12, gate: 'intimacy' },
    { minBond: 8, gate: 'kiss' },
    { minBond: 5, gate: 'handhold' },
    { minBond: 2, gate: 'hug' },
]);

/**
 * Bond-to-gate ladder computed at injection time; the Auditor never emits gate
 * text.
 * @param {number} bond
 * @returns {string | null} Gate name, or null below the first rung.
 */
export function resolveGate(bond) {
    for (const rung of GATE_LADDER) {
        if (bond >= rung.minBond) {
            return rung.gate;
        }
    }
    return null;
}

const DIFF_SECTIONS = Object.freeze(['turn_count', 'bonds', 'agendas', 'gm_notes', 'physics']);

/**
 * Continuity State values are plain JSON data, so serialized equality is
 * exact for every section (counters, steps, note strings, flags).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function isSameStateValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {Record<string, unknown>} Per-field [old, new] pairs; empty when equal.
 */
function diffStateFields(before, after) {
    /** @type {Record<string, unknown>} */
    const fields = {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) {
        if (!isSameStateValue(before[key], after[key])) {
            fields[key] = [before[key], after[key]];
        }
    }
    return fields;
}

/**
 * Record sections (bonds, agendas) use their keys as item ids: added and
 * removed keys report the whole item, surviving keys report changed fields.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {Record<string, unknown>}
 */
function diffStateRecordSection(before, after) {
    /** @type {Record<string, unknown>} */
    const report = {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const key of keys) {
        if (!(key in before)) {
            report[key] = { added: after[key] };
        } else if (!(key in after)) {
            report[key] = { removed: before[key] };
        } else {
            const fields = diffStateFields(
                /** @type {Record<string, unknown>} */ (before[key]),
                /** @type {Record<string, unknown>} */ (after[key]),
            );
            if (Object.keys(fields).length > 0) {
                report[key] = fields;
            }
        }
    }
    return report;
}

/**
 * The id-less gm_notes list diffs as a multiset so reorders and duplicate
 * counts stay truthful; both lists come back in their own original order.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {{ added: string[], removed: string[] }}
 */
function diffGmNotes(before, after) {
    const unmatched = new Map();
    for (const note of before) {
        unmatched.set(note, (unmatched.get(note) ?? 0) + 1);
    }
    const added = [];
    for (const note of after) {
        const count = unmatched.get(note) ?? 0;
        if (count > 0) {
            unmatched.set(note, count - 1);
        } else {
            added.push(note);
        }
    }
    const removed = [];
    for (const [note, count] of unmatched) {
        for (let index = 0; index < count; index++) {
            removed.push(note);
        }
    }
    return { added, removed };
}

/**
 * Build the gm_notes section report, or undefined when no notes changed.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {Record<string, unknown> | undefined}
 */
function diffGmNotesReport(before, after) {
    const { added, removed } = diffGmNotes(before, after);
    /** @type {Record<string, unknown>} */
    const noteReport = {};
    if (added.length > 0) {
        noteReport.added = added;
    }
    if (removed.length > 0) {
        noteReport.removed = removed;
    }
    return Object.keys(noteReport).length > 0 ? noteReport : undefined;
}

/**
 * Build one section's diff report.
 * @param {string} section
 * @param {unknown} before
 * @param {unknown} after
 * @returns {unknown} The section report, or undefined when it produced no entries.
 */
function diffSectionReport(section, before, after) {
    if (section === 'bonds' || section === 'agendas') {
        const record = diffStateRecordSection(
            /** @type {Record<string, unknown>} */ (before ?? {}),
            /** @type {Record<string, unknown>} */ (after ?? {}),
        );
        return Object.keys(record).length > 0 ? record : undefined;
    }
    if (section === 'gm_notes') {
        return diffGmNotesReport(
            /** @type {string[]} */ (before ?? []),
            /** @type {string[]} */ (after ?? []),
        );
    }
    if (section === 'physics') {
        const fields = diffStateFields(
            /** @type {Record<string, unknown>} */ (before ?? {}),
            /** @type {Record<string, unknown>} */ (after ?? {}),
        );
        return Object.keys(fields).length > 0 ? fields : undefined;
    }
    return [before, after];
}

/**
 * Compact per-section change report between two Continuity States for the
 * 'summaryception.continuity.audit.v1' console groups. Unchanged sections
 * are omitted; identical states yield an empty object. Scalar sections
 * report [old, new]; record sections report added/removed items and
 * per-field pairs; the id-less gm_notes list reports added/removed notes.
 * @param {SummaryceptionContinuityState} prior
 * @param {SummaryceptionContinuityState} next
 * @returns {Record<string, unknown>}
 */
export function diffContinuityStates(prior, next) {
    /** @type {Record<string, unknown>} */
    const report = {};
    for (const section of DIFF_SECTIONS) {
        const before = prior[section];
        const after = next[section];
        if (isSameStateValue(before, after)) {
            continue;
        }
        const sectionReport = diffSectionReport(section, before, after);
        if (sectionReport !== undefined) {
            report[section] = sectionReport;
        }
    }
    return report;
}
