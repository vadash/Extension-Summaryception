# One Call Session per summarizer call

`src/core/request-series.js` exports one factory, `createAttemptSession({ prompt, repairPrompt, signal, profile, notify })`, and the Call Session's whole interface is its facts plus `runSeries(route, { routeLabel, maxRetries })` — one hop in, one Route Series Result out. The session replaces the eight-parameter `runRouteSeries` call shape that re-threaded the same call facts through four layers of forwarding signatures: a new per-call fact is now added in one place instead of eight signatures across three files, the `systemPrompt` side-parameter is gone (the session reads `profile.policy.systemPrompt`), and the repair switch stays inside one hop, so a fallback hop starts back on the base prompt. What sits outside is deliberate: route cycling, the route-cycle failure budget, and the cross-request health buckets stay with `RequestRunner` because their state outlives a session, and above the runner nothing moves — `RequestRunner.run` and the pipeline input keep their ADR-0023 dispatch contract, while ADR-0024's one-series-per-hop decision is untouched; only its carrier changed.

## Considered Options

- **Keeping the eight-parameter threading** — the status quo tax: every new per-call fact edits eight JSDoc signatures across three files, and the helpers' interfaces stay nearly as complex as their forwarding bodies.
- **A session that also owns route cycling** — rejected: `primaryRetryExhaustedBuckets` survives across requests, so cycling state would need a new home outside the session anyway.
- **A per-hop session** — a narrower diff, but the runner still unpacks facts per hop and the attempt layer keeps the same forwarding signatures.

## Consequences

`request-series.js` has a single export; `notifyRouteCycleFailedAndWait` moves to `request-runner.js` beside the cycle policy it serves; `tests/request-series*.test.js` cross the seam through `session.runSeries(route, hop)` instead of a parameter bag, and `request-runner-outcomes.test.js` needs no change. `CONTEXT.md` gains the Call Session term beside Call Profile and Route Series.
