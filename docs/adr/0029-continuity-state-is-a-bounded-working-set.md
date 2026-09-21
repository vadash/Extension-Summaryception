# The Continuity State is a bounded working set, and the Continuity Block is its only output

The Continuity State exists to steer the main model, so a field either reaches the Continuity Block or it is pruned: `aware`, `fibs`, and `body_state` rendered into no block at all — 14 KB of a 20 KB state on the analysed chat — while being re-sent in full to the Auditor on every audit, and they restated the `[S]` notes and `physics` the Block already carried. The GM-note budget is stated in the Auditor prompt and enforced by code at 4 reminders, 8 threads, and 12 secrets, 24 total, because a preservation contract that says "never omit an untouched note" against a silent cap tells the Auditor to preserve exactly what the code discards; truncation is reported to the continuity state log instead of swallowed.

## Considered Options

- **Render `aware` as a fifth Block section** — rejected: asymmetric knowledge already ships as the `[S]` notes, which the Block renders, and two representations of one fact are what let the two drift apart.
- **Keep the three fields and cap their length** — rejected: a capped dump is still a dump, and the Auditor's per-call input is the larger cost of the two.
- **Leave the caps silent and uncap the `[S]` list** — rejected: an uncapped secrets list returns the state to unbounded growth, and a silent cap guarantees the same discard loop.

## Consequences

A Continuity Checkpoint written before this decision keeps the retired fields until the next settled audit overwrites the payload, and the renderer ignores them whenever it meets one; nothing migrates them.
