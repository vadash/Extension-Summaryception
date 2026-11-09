# Run Outcome vocabulary spans all five run levels; entry renders every notice

Core modules return one structured Run Outcome (`CONTEXT.md`, Run Outcome) and receive mid-run notices through a single notify adapter created at the composition root and passed by argument; every user-facing notice string, display duration, and update cadence lives in entry. `runManual` returns a `ManualRunOutcome` whose status one pure `deriveManualRunOutcome` derives from the loop's tally — an abort outranks the Foreground Gate, the Gate outranks giving up, giving up outranks progress — so the precedence is stated once.

## Considered Options

- **Toasting directly from core** — bare `toastr` globals bypass the host facade, and retry delays fuse to toast lifetimes.
- **Threading `status` through the four sites that know a reason** — each site would then hold one slice of the precedence.
- **Deriving the status from `fullyCommitted`** — two fields would answer "what happened".

## Consequences

The auto cycle treats anything but `completed` as terminal and the Promotion Drain collapses blocked or failed work, so `partial` has one producer: the Manual Run, a target-reaching run with a failed batch.
