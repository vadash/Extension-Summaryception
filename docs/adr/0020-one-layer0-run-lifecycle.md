# One Layer 0 Run lifecycle owns every Layer 0 commit

One module (`src/core/layer0-run.js`) turns one or more Passages into committed Layer 0 Snippets behind one interface: `runLayer0(routePlan, notify)` returns a Run Outcome and never throws, replacing `summarizeBatchFromTurns`, `summarizeAtomicLayer0Partitions`, and the engine's `commitMode` dispatch. The Route Plan is the whole argument — `SummaryRoutePlan` already carries `commitMode`, `batchTurns`, `partitions`, `sourceEndIdx`, and `totalBatches` — and the run absorbs the pre-run duties that sat above it: stable-ID assignment, the eligibility filter, the boundary-to-`passageStart` derivation, and the Ghosting repair for a run with nothing to cover. Passages are the run's unit, dispatched with `buildFullContext(0)` first and the accumulated pending context after, and no caller infers the verdict: a commit the Foreground Gate queues is `blocked` at run level, `aborted` stays `aborted` instead of folding into `failed`, and blocked or idle work is not logged as a failure.

## Considered Options

- **Prebuilt units with caller-supplied context** — puts the context-accumulation rule back in each caller, which is the copying this change removes.
- **One entry point per commit mode** — two entries sharing collaborators is the state being replaced.
- **Keeping the `catchExceptions` option** — both production call sites passed `true`, and its whole effect was converting a throw into `{ status: 'failed' }`, which the run now returns anyway.

## Consequences

Two behaviours are load-bearing and unchanged: the freshness check compares the run's **first** basis before each Passage after the first, so any store or chat change since the run began aborts the remaining Passages instead of burning doomed requests, and the commit re-validates every entry, which is what makes a queued commit safe to apply at flush time. One recorded delta: a run with nothing to cover now repairs Ghosting ownership on every route, where only the turns-based path did before — the reach is narrow and the repair idempotent. `summarizer-batch.js` becomes `layer0-run.js`, `CONTEXT.md` gains the Layer 0 Run term, and Snippet Regeneration's own capture-dispatch-commit, the Promotion Drain's loop, and the Memory Injection opportunities stay out of scope.
