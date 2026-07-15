# Engine

## Memory model

- Layer 0 summarizes turns selected beyond dynamic verbatim window. `[STATE]` is a complete bounded rolling snapshot, not a delta; new snippets carry `stateMode: snapshot-v1`, and injection uses only the newest snapshot.
- `layer0-compression.js` validates Layer 0 sections independently after cleanup and integrity validation: `layer0SummaryTokenTarget` is the `[NARRATIVE]` soft target with a 1.5× model-facing maximum plus a narrow 1.65× repair ceiling to avoid retrying provider near misses. Rolling `[STATE]` uses the fixed 200-token soft target and 300-token model-facing maximum; states through 360 tokens receive deterministic snapshot compaction before an LLM repair is requested. Provider output caps are separate; never derive them from `layer0SummaryTokenTarget`.
- Snapshot state uses fixed continuity fields and a 300-token generated-output ceiling plus a 1,200-character injection safeguard. Legacy chats fall back to recognized fields from only the newest three Layer 0 snippets until their first snapshot is written.
- Layers 1+ promote older snippets. Narrative is compressed by LLM using moderate macro-level priorities: durable transitions, names/places needed for continuity, lasting agreements, current position, and unresolved hooks survive while brands, errands, meals, clothing, one-off supplies, dialogue, and mechanical scene replay are dropped. Source-size compression accounting counts source narratives only, while rolling states remain contextual input. Snapshot sources use the final snapshot in the promoted span and are not merged or carried into a complete remaining snapshot.
- Promotion uses a 40% narrative soft target and 60% hard maximum, starts only for over-limit layers, and merges at least configured `snippetsPerPromotion` (defensively no fewer than three). `summarizer-promotion.js` owns quota details and reports when token pressure cannot progress because the minimum batch is unavailable.
- Any change to `store.layers`, snippet text/metadata, or related committed summary state must bump mutation epoch.

## Planning and execution

- `partition-planner.js` splits Layer 0 sources on assistant-turn boundaries using token-balanced partitions.
- `summarization-routes.js` normalizes Standard, Cache, Force, and Slop plans. Planner-specific countability stays inside planner modules.
- Cache auto-flush summarizes all planned partitions before one atomic commit, feeding each pending snapshot into the next partition's context. Force and Slop keep sequential partial commits.
- Shared route execution and promotion loops live in `summarizer-engine.js`; queue lifecycle lives in `summarizer-queue.js`.
- Prompt-affecting commits/effects queue while SillyTavern foreground generation is active. Generation end flushes pending work through `summarizer-commit.js`.
- Request-only prompt rewrites use `GENERATE_AFTER_DATA`, mutate final payload in place, and never persist rewritten roles/content into chat history.

## Connections

- Adapters live in `src/core/connection-*.js`; `connectionutil.js` resolves routes and shared access.
- OpenAI-compatible SSE reads must reach `data: [DONE]`. EOF or disconnect before marker is retryable failure.
- Retry policy uses exponential backoff. Hard network failures such as `failed to fetch` or `ECONNREFUSED` skip normal primary retries and try configured fallback immediately.
- Keep each connection source independently testable.

## Injection and ghosting

- `memory-injection.js` compiles one current-state block plus chronology. `memory-budget.js` applies injected-memory budget.
- Effective injected memory uses compact `[start-end@YYYY-MM-DDTHH]` chronology anchors; summarizer and promotion context retain verbose anchors, and budget accounting follows the compact rendered form.
- Direct placement uses `setExtensionPrompt()`. Macro Only exposes `{{summaryception_memory}}` and clears direct injection.
- Ghosting uses SillyTavern `/hide`; originals stay visible in chat UI. Ownership is tracked by `extra.sc_ghosted` and `store.ghostedIndices`.
- Clearing uses `/unhide` only for Summaryception-owned ranges. Reconciliation repairs missing ownership/visual hides and trims invalid indices.
