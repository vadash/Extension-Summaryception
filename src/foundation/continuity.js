import { clampInteger } from './numeric.js';

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
 * @param {unknown} value
 * @returns {SummaryceptionContinuityBond}
 */
function normalizeBondPair(value) {
    const source = isRecord(value) ? value : {};
    return {
        bond: clampInteger(source.bond, BOND_BOUNDS.bond[0], BOND_BOUNDS.bond[1]),
        sparks: clampInteger(source.sparks, BOND_BOUNDS.sparks[0], BOND_BOUNDS.sparks[1]),
        grudge: clampInteger(source.grudge, BOND_BOUNDS.grudge[0], BOND_BOUNDS.grudge[1]),
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
    return state;
}

/**
 * Classify raw Auditor JSON against the v1 continuity schema without freezing
 * or merging: the caller owns the freeze decision from sectionVerdicts.
 * Field damage is clamped into the returned state; missing sections, an
 * unknown pair key, or an unknown note tag produce a section verdict.
 * @param {unknown} raw
 * @returns {{ state: SummaryceptionContinuityState | null, sectionVerdicts: string[] }}
 */
export function classifyContinuity(raw) {
    let parsed;
    try {
        parsed = JSON.parse(/** @type {string} */ (raw));
    } catch {
        return { state: null, sectionVerdicts: ['parse'] };
    }
    const source = isRecord(parsed) ? parsed : {};
    const state = createDefaultContinuity();
    const sectionVerdicts = [];

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

    return { state, sectionVerdicts };
}
