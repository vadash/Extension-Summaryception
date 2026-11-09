# One Layer 0 Run lifecycle owns every Layer 0 commit

One module (`src/core/layer0-run.js`) turns Passages into committed Layer 0 Snippets behind one `runLayer0` entry returning a Run Outcome and never throwing, replacing the batch summarizers and the `commitMode` dispatch. The Route Plan is the whole argument; the run absorbs stable-ID assignment, the eligibility filter, the boundary-to-`passageStart` derivation, and the Ghosting repair for an empty run. Passages are the run's unit, dispatched with `buildFullContext(0)` first and the accumulated pending context after, and no caller infers the verdict: a Foreground-Gate-queued commit is `blocked`, `aborted` stays `aborted` rather than folding into `failed`, and blocked or idle work is not logged as failure.

## Consequences

The freshness check compares the run's first basis before each later Passage, so a store or chat change aborts the rest instead of burning doomed requests; the commit re-validates every entry, so a queued commit is safe at flush time. A run with nothing to cover now repairs Ghosting ownership on every route.
