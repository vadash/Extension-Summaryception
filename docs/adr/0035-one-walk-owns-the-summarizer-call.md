# One walk owns the summarizer call

`RequestRunner.run(request)` in `src/core/request-runner.js` is the single walk of one summarizer call: it cycles the Connection Routes, runs each hop's attempts until `getRetryStopReason` gives its verdict, switches to the repair prompt, waits between retries and route cycles, and returns one Run Outcome, so the former per-hop module, its session factory, the series result vocabulary, and the bridging translators are deleted. Retry policy stays its own submodule (ADR-0019) and the Connection Route catalogue stays untouched (ADR-0026); transport and the Usage Ledger stay injected adapters, and the call facts are destructured once by `run` and forwarded as explicit narrow parameters instead of being carried across internal seams in a live per-call object. The route-cycle failure budget, health-bucket probing, and the cycle wait stay in the walk.

## Considered Options

- **Keeping two seams and translating between their result vocabularies** — the runner and the per-hop module each classified the same failure, so retry-exhaustion semantics had to land twice; those translators are what this merge deletes.
- **Moving route cycling into the retry-policy submodule** — rejected: retry policy answers one attempt's verdict and wait, while cycling reads the Call Profile's routes and the runner's cross-request health buckets.

## Consequences

ADR-0024 and ADR-0030 are superseded. The former series tests become `tests/request-runner-*.test.js` and drive `RequestRunner.run`; `CONTEXT.md` drops the two retired terms and gains the Summarizer Call Walk.
