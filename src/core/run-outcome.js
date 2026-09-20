/**
 * Structured result of one run level: summarizer request, batch commit,
 * promotion drain, auto cycle, or manual run. Producers fill the count fields
 * they know. The summarizer response `text` never travels above the request
 * runner.
 * @typedef {object} SummarizationRunOutcome
 * @property {'completed' | 'partial' | 'aborted' | 'blocked' | 'failed' | 'idle'} status - Terminal run status; `idle` marks no eligible work, `partial` a run that stopped short of its intended work.
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

/**
 * The run state one manual run accumulates before its verdict: counts plus the
 * reasons its loop stopped. Reasons are not outcomes; only
 * `deriveManualRunOutcome` turns them into one.
 * @typedef {object} ManualRunTally
 * @property {number} completed - Batches committed.
 * @property {number} failed - Batches that failed.
 * @property {number} totalBatches - Batches planned for the run.
 * @property {boolean} aborted - The user or the Work Gate stopped the run.
 * @property {boolean} blocked - The Foreground Gate closed.
 * @property {boolean} failureLimitReached - The run gave up on consecutive failures.
 */

/**
 * Terminal result of one manual run: the status its notice is selected by, plus
 * the counts that notice is phrased from.
 * @typedef {object} ManualRunOutcome
 * @property {'completed' | 'partial' | 'aborted' | 'blocked' | 'failed' | 'idle'} status - One verdict per run (see deriveManualRunOutcome).
 * @property {number} completed - Batches committed.
 * @property {number} failed - Batches that failed.
 * @property {number} totalBatches - Batches planned for the run.
 */

/**
 * One manual run's verdict. Precedence: an abort outranks the gate, the gate
 * outranks giving up, and giving up outranks progress. Only a run that reached
 * its target with no failures and a drained promotion is `completed`; a run
 * that stopped short of its target is `partial`, and one that neither committed
 * nor failed a batch did nothing at all.
 * @param {ManualRunTally} tally
 * @param {{ targetReached?: boolean, promotionCompleted?: boolean }} [facts] - What the loop cannot see: the target boundary and the promotion drain.
 * @returns {ManualRunOutcome}
 */
export function deriveManualRunOutcome(
    tally,
    { targetReached = false, promotionCompleted = false } = {},
) {
    const { aborted, blocked, completed, failed, failureLimitReached, totalBatches } = tally;
    /** @type {ManualRunOutcome['status']} */
    let status = 'partial';
    if (aborted) {
        status = 'aborted';
    } else if (blocked) {
        status = 'blocked';
    } else if (failureLimitReached) {
        status = 'failed';
    } else if (completed === 0 && failed === 0) {
        status = 'idle';
    } else if (completed > 0 && failed === 0 && targetReached && promotionCompleted) {
        status = 'completed';
    }
    return { status, completed, failed, totalBatches };
}
