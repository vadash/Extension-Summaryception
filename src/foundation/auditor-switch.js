/**
 * The one temporary Auditor kill switch. The Continuity Audit run entry and
 * the Continuity Block injection both read it, so re-enabling the Auditor is
 * one line: flip the flag.
 */
// TEMP: Auditor disabled until the prompt rewrite lands; re-enable by flipping the flag below.
export const AUDITOR_DISABLED = true;
