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
function isRecord(value) {
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
        anchor_sc_id: '',
        stale: false,
    };
}

/**
 * Sanitize the stored continuity tree in place; malformed entries are dropped
 * (mirrors normalizeLayers), absent or garbage field becomes cold start.
 * @param {unknown} continuity
 * @returns {SummaryceptionContinuityState}
 */
export function normalizeContinuity(continuity) {
    if (!isRecord(continuity)) {
        return createDefaultContinuity();
    }
    const state = /** @type {SummaryceptionContinuityState} */ (
        /** @type {unknown} */ (continuity)
    );
    state.turn_count = clampInteger(state.turn_count, 0, Number.MAX_SAFE_INTEGER);
    const bonds = /** @type {Record<string, SummaryceptionContinuityBond>} */ ({});
    for (const [key, value] of Object.entries(isRecord(state.bonds) ? state.bonds : {})) {
        if (USER_PAIR_PATTERN.test(key)) {
            bonds[key] = normalizeBondPair(value);
        }
    }
    state.bonds = bonds;
    const agendas = /** @type {Record<string, SummaryceptionAgenda>} */ ({});
    for (const [key, value] of Object.entries(isRecord(state.agendas) ? state.agendas : {})) {
        agendas[key] = normalizeAgenda(value);
    }
    state.agendas = agendas;
    state.gm_notes = filterGmNotes(Array.isArray(state.gm_notes) ? state.gm_notes : []).kept;
    state.physics = normalizePhysics(state.physics);
    state.anchor_sc_id = typeof state.anchor_sc_id === 'string' ? state.anchor_sc_id : '';
    state.stale = state.stale === true;
    return state;
}

/**
 * Classify raw Auditor JSON against the v1 continuity schema without freezing
 * or merging: the caller owns the freeze decision from sectionVerdicts.
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
    /** @type {Record<string, Record<string, unknown>>} */
    const flags = {};

    if (source.turn_count === undefined) {
        sectionVerdicts.push('turn_count');
    } else {
        state.turn_count = clampInteger(source.turn_count, 0, Number.MAX_SAFE_INTEGER);
    }

    if (isRecord(source.bonds)) {
        let unknownPair = false;
        for (const [key, value] of Object.entries(source.bonds)) {
            if (!USER_PAIR_PATTERN.test(key)) {
                unknownPair = true;
            }
            state.bonds[key] = normalizeBondPair(value);
            if (isRecord(value)) {
                flags[key] = value;
            }
        }
        if (unknownPair) {
            sectionVerdicts.push('bonds');
        }
    } else {
        sectionVerdicts.push('bonds');
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
 * Count assistant messages strictly after the anchor sc_id.
 * @param {ChatMessage[] | unknown} chat
 * @param {string} anchorScId - '' counts from chat start; returns null when a
 *   non-empty anchor is missing from the chat (the caller re-anchors).
 * @returns {number | null}
 */
export function deriveTurnCount(chat, anchorScId) {
    const indices = listAssistantIndicesAfter(chat, anchorScId);
    return indices === null ? null : indices.length;
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
