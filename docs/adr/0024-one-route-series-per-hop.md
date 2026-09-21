# One Route Series owns one Narrative Chain hop

One module (`src/core/request-series.js`) owns one connection route's retry series behind one interface: `runRouteSeries({ prompt, repairPrompt, signal, profile, route, routeLabel, maxRetries, notify })` returns a Route Series Result and only classifies provider throws, never surfacing raw exception objects to its caller. It replaces `RequestRunner.runAttemptSeries` and its prepared-attempt helpers and deletes `src/core/request-attempt.js`, so the runner shrinks to what routing owns: route walking, the health bucket, the route-cycle wait, and the Run Outcome verdicts. The attempt returns one `AttemptResult` — `completed`, `aborted`, `hard-failover`, `failed{retryable}`, `rejected{reason}`, or `guard-stopped` — replacing a triple-encoded bag of a live settings read, boolean flags, and a `failureStatus` string the log layer re-mapped, which is why the attempt status and the transaction log can no longer drift apart.

## Considered Options

- **Recomputing exhaustion in each caller** — the old callers derived "retries ran out" three ways; the series encodes it once, since `failed{retryable}` and `rejected` surface exclusively after the budget ran out and `hard-failover` after it was skipped.
- **Mocking `runSingleAttempt` in the runner's outcome tests** — the real bugs sat above the mock, in how attempts compose and where retry waits surface, so the suite now mocks only `sendSummarizerRequest`.

## Consequences

`CONTEXT.md` gains the Route Series term beside Narrative Chain, and `tests/request-series*.test.js` replace the `request-attempt-*.test.js` files. One documented event delta: the runner's guard-block outcome now sees the attempt layer's structured `easy-guard-blocked` event reach the notify adapter, which is what ADR-0019 already specified.
