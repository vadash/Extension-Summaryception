import { clampInteger } from '../foundation/numeric.js';
import { AUDITOR_NOTE_KIND_CAPS, AUDITOR_NOTE_TOTAL_CAP } from '../foundation/prompt-constants.js';
import { recoverContinuityJson } from './parse-recovery.js';

const BOND_BOUNDS = Object.freeze({ bond: [-5, 20], sparks: [0, 99], grudge: [0, 99] });
const STEP_CEILING = 99;
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
 * The assistant-reply test every Continuity chat walk shares: a present
 * message that is not the user turn. Prompt visibility is not part of a
 * reply's identity — Ghosting hides a summarized reply through the host's
 * hide command, which marks that reply as a system line, and a hidden reply is
 * still an Exchange (ADR-0028).
 * @param {ChatMessage} [message]
 * @returns {boolean}
 */
export function isAssistantMessage(message) {
    if (!message) {
        return false;
    }
    return !message.is_user;
}

/**
 * Turn Count: the number of assistant turns in the chat, re-derived from the
 * chat at every audit (ADR-0006). Coverage consumes this derivation, and the
 * Conversion multiples evaluate against the count an audit applies.
 * @param {ChatMessage[] | unknown} chat
 * @returns {number}
 */
export function deriveTurnCount(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    let count = 0;
    for (const message of messages) {
        if (isAssistantMessage(message)) {
            count += 1;
        }
    }
    return count;
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
 * against the clamped max. Retired fields a stored payload still carries are
 * ignored, not migrated (ADR-0029).
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
    };
}

/**
 * Keeps only tagged strings in order, truncating per kind and then total; the
 * Auditor orders notes by priority, so first-seen wins. How many notes the
 * budget dropped is reported to the caller, which is what makes the cap
 * observable instead of silent (ADR-0029).
 * @param {unknown[]} notes
 * @returns {{ kept: string[], unknownTag: boolean, truncated: number }}
 */
function filterGmNotes(notes) {
    const kept = [];
    const perKind = { R: 0, T: 0, S: 0 };
    let unknownTag = false;
    let truncated = 0;
    for (const entry of notes) {
        const note = typeof entry === 'string' ? entry : null;
        const match = note !== null ? note.match(NOTE_TAG_PATTERN) : null;
        if (note === null || !match) {
            unknownTag = true;
            continue;
        }
        if (
            perKind[match[1]] >= AUDITOR_NOTE_KIND_CAPS[match[1]] ||
            kept.length >= AUDITOR_NOTE_TOTAL_CAP
        ) {
            truncated += 1;
            continue;
        }
        perKind[match[1]] += 1;
        kept.push(note);
    }
    return { kept, unknownTag, truncated };
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
 * Auditor actually said. A reply that needed Parse Recovery reports its tier
 * for the audit log; section verdicts stay the only semantic gate, so a
 * rescued draft commits when its sections classify clean (ADR-0009).
 * @param {string | unknown} raw - Raw JSON text or an already-parsed value.
 * @returns {{ state: SummaryceptionContinuityState | null, sectionVerdicts: string[], flags: Record<string, Record<string, unknown>>, notesTruncated: number, recoveryTier: number | null }} notesTruncated counts the notes the budget dropped; it is not a verdict, because a verdict here would fail every audit at saturation (ADR-0029). recoveryTier is the Parse Recovery tier that rescued the reply, or null for a clean tier-1 parse or a total parse failure.
 */
export function classifyContinuity(raw) {
    const isString = typeof raw === 'string';
    const recovery = isString ? recoverContinuityJson(raw) : null;
    const parsed = isString ? (recovery !== null ? recovery.value : undefined) : raw;
    if (parsed === undefined) {
        return {
            state: null,
            sectionVerdicts: ['parse'],
            flags: {},
            notesTruncated: 0,
            recoveryTier: null,
        };
    }
    const recoveryTier = recovery !== null && recovery.tier > 1 ? recovery.tier : null;
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

    let notesTruncated = 0;
    if (Array.isArray(source.gm_notes)) {
        const filtered = filterGmNotes(source.gm_notes);
        state.gm_notes = filtered.kept;
        notesTruncated = filtered.truncated;
        if (filtered.unknownTag) {
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

    return {
        state,
        sectionVerdicts,
        flags,
        notesTruncated,
        recoveryTier,
    };
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
