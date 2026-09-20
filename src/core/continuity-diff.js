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
