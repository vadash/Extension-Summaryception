/**
 * OpenVault-style prompt assemblers shared by every summarizer prompt template.
 *
 * A system prompt is `<role>` plus optional `<role_invariants>`.
 * A user prompt is the `<input>` blocks, then `<output_schema>`, then
 * `<task_rules>`, then `<critical_rules>` (omitted when empty), then the
 * bare `EXECUTION_TRIGGER` line.
 *
 * Pure functions; no settings or runtime imports.
 */

/**
 * @param {string} role
 * @param {string} [invariants]
 * @returns {string}
 */
export function buildSystemPrompt(role, invariants) {
    let out = `<role>\n${role}\n</role>`;
    if (typeof invariants === 'string' && invariants.length > 0) {
        out += `\n\n<role_invariants>\n${invariants}\n</role_invariants>`;
    }
    return out;
}

/**
 * @param {object} args
 * @param {string} args.inputBlocks - One or more `<input>` XML blocks.
 * @param {string} args.schemaBlock - The `<output_schema>` body.
 * @param {string} args.taskRules - The `<task_rules>` body (durability and format rules).
 * @param {string} [args.criticalRules] - The `<critical_rules>` body; omitted when empty.
 * @param {string} args.triggerLine - Bare affirmative imperative line.
 * @returns {string}
 */
export function buildUserPrompt({
    inputBlocks,
    schemaBlock,
    taskRules,
    criticalRules,
    triggerLine,
}) {
    const parts = [inputBlocks, `<output_schema>\n${schemaBlock}\n</output_schema>`];
    parts.push(`<task_rules>\n${taskRules}\n</task_rules>`);
    if (typeof criticalRules === 'string' && criticalRules.length > 0) {
        parts.push(`<critical_rules>\n${criticalRules}\n</critical_rules>`);
    }
    parts.push(triggerLine);
    return parts.join('\n\n');
}

export const EXECUTION_TRIGGER_L0 =
    'Now output the [NARRATIVE] section and the current_date_time key line with no preamble, code fences, or commentary.';

export const EXECUTION_TRIGGER_PROMO =
    'Now output exactly one [NARRATIVE] paragraph with no preamble, code fences, or commentary.';

/**
 * Insert `insert` immediately before the trailing `triggerLine` of an
 * assembled user prompt. Runtime appenders use this to place dynamic
 * budget hints, source-range lines, and repair-feedback blocks above the
 * bare execution trigger so the model starts emitting at once.
 *
 * When the prompt does not end with `triggerLine` (for example a custom
 * user-edited setting instead of a `buildUserPrompt` template), the
 * fallback appends after the body so the dynamic content is never lost.
 * Empty `insert` returns the prompt unchanged.
 * @param {string} prompt
 * @param {string} insert
 * @param {string} triggerLine
 * @returns {string}
 */
export function insertBeforeTrigger(prompt, insert, triggerLine) {
    const body = String(prompt ?? '');
    const trigger = String(triggerLine ?? '');
    const trimmed = body.trimEnd();
    if (trigger && trimmed.endsWith(trigger)) {
        const head = trimmed.slice(0, trimmed.length - trigger.length).trimEnd();
        const extra = String(insert ?? '').trim();
        return extra ? `${head}\n\n${extra}\n\n${trigger}` : `${head}\n\n${trigger}`;
    }
    const extra = String(insert ?? '').trim();
    return extra ? `${body.trimEnd()}\n\n${extra}` : body;
}
