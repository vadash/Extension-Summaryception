/**
 * OpenVault-style prompt assemblers shared by every summarizer prompt template.
 *
 * A summarizer request is three messages (ADR-0033):
 * - system: the static declarative tags `<role>`, `<inv>`, `<out>`, `<task>`,
 *   `<rules>`; identical for every call of a family.
 * - payload: the `<in>` block plus the runtime provenance fragments.
 * - recall: the compliance pair, the one-forward-pass leash, the family's
 *   numbered tasks, the attempt feedback, the volatile limits, then the bare
 *   execution trigger as its final line. Recall is what keeps the constraints
 *   inside a long passage's attention.
 *
 * Pure functions; no settings or runtime imports.
 */

/**
 * @param {string} role
 * @param {string} [invariants] - The `<inv>` body; omitted when empty.
 * @param {object} [sections]
 * @param {string} [sections.output] - The `<out>` body.
 * @param {string} [sections.taskRules] - The `<task>` body.
 * @param {string} [sections.criticalRules] - The `<rules>` body.
 * @returns {string}
 */
export function buildSystemPrompt(role, invariants, sections = {}) {
    const parts = [`<role>\n${role}\n</role>`];
    appendTaggedBlock(parts, 'inv', invariants);
    appendTaggedBlock(parts, 'out', sections.output);
    appendTaggedBlock(parts, 'task', sections.taskRules);
    appendTaggedBlock(parts, 'rules', sections.criticalRules);
    return parts.join('\n\n');
}

/**
 * @param {object} args
 * @param {string} args.inputBlocks - The `<player>`, `<prior>`, and `<passage>` blocks.
 * @param {string} [args.fragments] - Runtime provenance: budget hint, source range.
 * @returns {string}
 */
export function buildUserPrompt({ inputBlocks, fragments = '' }) {
    const payload = `<in>\n${inputBlocks}\n</in>`;
    return isNonEmpty(fragments) ? `${payload}\n\n${fragments}` : payload;
}

/**
 * Render a recall body: the compliance pair, the leash, then one numbered line
 * per task. The limits and the trigger stay out; they are per-attempt.
 * @param {object} args
 * @param {string} args.compliance - The verbatim compliance pair.
 * @param {string} args.leash - The one-forward-pass leash header.
 * @param {ReadonlyArray<string>} args.tasks - One-line tasks, numbered in order.
 * @returns {string}
 */
export function buildRecallBody({ compliance, leash, tasks }) {
    const numbered = (tasks || []).map((task, index) => `${index + 1}. ${task}`);
    return [compliance, leash, ...numbered].join('\n');
}

/**
 * Render the last request message from a recall body: the body, optional
 * attempt feedback, the `limits:` section, and the execution trigger as the
 * final line. An empty body means the family carries no recall block (the
 * Auditor), so the whole message is empty and the request stays two messages.
 * @param {object} args
 * @param {string} args.body - The recall body from `buildRecallBody` or a setting.
 * @param {string[]} [args.limits] - Volatile size and repair lines.
 * @param {string} [args.feedback] - Attempt-local repair feedback; empty omits it.
 * @param {string} args.triggerLine - The execution trigger.
 * @returns {string}
 */
export function buildRecallBlock({ body, limits = [], feedback = '', triggerLine }) {
    if (!isNonEmpty(body)) {
        return '';
    }

    const parts = [String(body).trim()];
    if (isNonEmpty(feedback)) {
        parts.push(String(feedback).trim());
    }
    const limitLines = (limits || [])
        .map((line) => String(line ?? '').trimEnd())
        .filter(isNonEmpty);
    if (limitLines.length > 0) {
        parts.push(['limits:', ...limitLines].join('\n'));
    }
    return `<recall>\n${parts.join('\n')}\n</recall>\n${triggerLine}`;
}

/**
 * Insert attempt-local feedback into an assembled recall block, above its
 * `limits:` section; without one it lands just before the close tag, so the
 * execution trigger stays the final line. Empty feedback returns the block
 * unchanged.
 * @param {string} recallBlock
 * @param {string} feedback
 * @returns {string}
 */
export function appendRecallFeedback(recallBlock, feedback) {
    const extra = String(feedback ?? '').trim();
    const block = String(recallBlock ?? '');
    if (!extra || !block) {
        return block;
    }
    const limitsIndex = block.indexOf('\nlimits:');
    if (limitsIndex !== -1) {
        return `${block.slice(0, limitsIndex)}\n${extra}${block.slice(limitsIndex)}`;
    }
    const closeIndex = block.lastIndexOf('</recall>');
    if (closeIndex !== -1) {
        return `${block.slice(0, closeIndex)}${extra}\n${block.slice(closeIndex)}`;
    }
    return `${block}\n${extra}`;
}

export const EXECUTION_TRIGGER_L0 =
    'Now write the <narrative> envelope and the current_date_time line.';

export const EXECUTION_TRIGGER_PROMO = 'Now write the <narrative> envelope.';

export const EXECUTION_TRIGGER_AUDITOR =
    'Now output exactly one JSON state object with no preamble, code fences, or commentary.';

function appendTaggedBlock(parts, tag, body) {
    if (isNonEmpty(body)) {
        parts.push(`<${tag}>\n${body}\n</${tag}>`);
    }
}

function isNonEmpty(value) {
    return typeof value === 'string' && value.length > 0;
}
