# One walk owns the summarizer call

`RequestRunner.run(request)` in `src/core/request-runner.js` is the single walk of one summarizer call: it cycles the Connection Routes, runs each hop's attempts until `getRetryStopReason` gives its verdict, switches to the repair prompt, and returns one Run Outcome, so the per-hop module, its session factory, the series result vocabulary, and the bridging translators are deleted. Retry policy stays its own submodule (ADR-0019), the route catalogue is untouched (ADR-0026), and the route-cycle failure budget, health-bucket probing, and cycle wait stay in the walk.

## Considered Options

- **Moving route cycling into the retry-policy submodule** — rejected: retry policy answers one attempt's verdict and wait, while cycling reads the Call Profile's routes and the runner's cross-request health buckets.

## Consequences

The former series tests become `tests/request-runner.test.js`; `CONTEXT.md` drops Call Session and Route Series and gains the Summarizer Call Walk.
