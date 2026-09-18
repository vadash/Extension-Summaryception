/**
 * Structured result of one run level: summarizer request, batch commit,
 * promotion drain, or auto cycle. Producers fill the count fields they know.
 * The summarizer response `text` never travels above the request runner.
 * @typedef {object} SummarizationRunOutcome
 * @property {'completed' | 'aborted' | 'blocked' | 'failed' | 'idle'} status - Terminal run status; `idle` marks no eligible work.
 * @property {number} [attempts] - Promotions attempted by a drain.
 * @property {number} [completed] - Batches committed successfully.
 * @property {number} [failed] - Batches that failed.
 * @property {number} [totalBatches] - Batches planned for the run.
 */

/**
 * Structured result of one summarizer request (ADR-0004). The deepest shared
 * request entry returns this instead of an empty-string sentinel. Completed
 * outcomes carry the resolved Call Profile so post-hoc output validation
 * consumes the same frozen policy the request ran under (ADR-0008).
 * @typedef {object} RunOutcome
 * @property {'completed' | 'aborted' | 'blocked' | 'failed'} status - Terminal request status.
 * @property {string} [text] - Summary text; present only when status is 'completed'.
 * @property {import('./call-profile.js').CallProfile} [profile] - Call profile resolved at dispatch; present only when status is 'completed'.
 * @property {number} [attempts] - Attempts actually made; present only when status is 'failed'.
 */

export {};
