# Run Outcome vocabulary spans all five run levels; entry renders every notice

Core modules return one structured Run Outcome (`CONTEXT.md`, Run Outcome) and receive mid-run notices through a single notify adapter created at the composition root and passed by argument; every user-facing notice string, display duration, and update cadence lives in entry. `runManual` returns a `ManualRunOutcome` whose status one pure `deriveManualRunOutcome` derives from the loop's tally — an abort outranks the Foreground Gate, the Gate outranks giving up, giving up outranks progress — so the precedence is stated once instead of at the four sites that know a reason. Supersedes ADR-0004.

## Considered Options

- **Toasting directly from core** — bare `toastr` globals bypass the host facade, retry delays fuse to toast lifetimes, and the `''` return collapsed abort, guard block, and failure into one indistinguishable sentinel.
- **Per-call-site toast callbacks** — one notify adapter with a silent test recorder is two real adapters at one seam, testable without DOM or toastr.
- **Threading `status` through the four sites that know a reason** — each site would then hold one slice of the precedence.
- **Deriving the status from `fullyCommitted`** — two fields would answer "what happened", and the count-based notices would have to re-implement the target test to select themselves.

## Consequences

The auto cycle keeps treating anything but `completed` as terminal and the Promotion Drain still collapses "committed some promotions, then blocked or failed", so `partial` currently has one producer: the Manual Run. A run that reaches its target but had a failed batch is `partial`, where the old count-based branch called it "Catch-up complete!" about a run that had failed work in it.
