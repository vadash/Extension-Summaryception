/**
 * OpenVault-style prompt assemblers shared by every summarizer prompt template.
 *
 * A system prompt is `<role>` plus optional `<inv>`.
 * A user prompt is the `<in>` payload, then `<out>`, then `<task>`, then
 * `<rules>` (omitted when empty), then the bare `EXECUTION_TRIGGER` line.
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
        out += `\n\n<inv>\n${invariants}\n</inv>`;
    }
    return out;
}

/**
 * @param {object} args
 * @param {string} args.inputBlocks - The `<player>`, `<prior>`, and `<passage>` payload blocks.
 * @param {string} args.schemaBlock - The `<out>` body.
 * @param {string} args.taskRules - The `<task>` body (salience and compression rules).
 * @param {string} [args.criticalRules] - The `<rules>` body; omitted when empty.
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
    const parts = [`<in>\n${inputBlocks}\n</in>`, `<out>\n${schemaBlock}\n</out>`];
    parts.push(`<task>\n${taskRules}\n</task>`);
    if (typeof criticalRules === 'string' && criticalRules.length > 0) {
        parts.push(`<rules>\n${criticalRules}\n</rules>`);
    }
    parts.push(triggerLine);
    return parts.join('\n\n');
}

export const EXECUTION_TRIGGER_L0 =
    'Now write the <narrative> envelope and the current_date_time line.';

export const EXECUTION_TRIGGER_PROMO = 'Now write the <narrative> envelope.';

export const EXECUTION_TRIGGER_AUDITOR =
    'Now output exactly one JSON state object with no preamble, code fences, or commentary.';

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
