# Engine

## Memory model

- Layer 0 summarizes turns selected beyond dynamic verbatim window. `[STATE]` is a complete bounded rolling snapshot, not a delta; new snippets carry `stateMode: snapshot-v1`, and injection uses only the newest snapshot.
- `layer0-compression.js` validates Layer 0 sections independently after cleanup and integrity validation. `layer0SummaryTokenTarget` is the `[NARRATIVE]` soft target with a 1.5x model-facing maximum plus a narrow 1.65x repair ceiling, avoiding retries on provider near misses. Rolling `[STATE]` uses fixed 200-token soft target, 300-token model-facing maximum, and a 1,056-char deterministic-compaction target (kept below the 1,200-char injection safeguard so accepted trims land safely under the token hard max even for denser scripts). Provider output caps are separate; never derive them from `layer0SummaryTokenTarget`.
- Layer 0 `[STATE]` size compaction: `prompts.js` runs deterministic snapshot compaction (`compactStateNearMiss` → `summarizer-state.js` `compactStateSnapshotText`) **without a magnitude gate** — any oversized state is trimmed once on the first validation pass, and a post-trim token check rejects what still can't fit. There is no second salvage pass: the compactor is deterministic, so retrying it yields an identical result. Do NOT reintroduce an upper-token/char ceiling that refuses to try compaction (the old 360-token gate did this): dense (Cyrillic) blocks measured over the ceiling but trim cleanly, and refusing them forced wasteful full LLM retries on the very outputs the compactor was built to handle. The token-count fallback estimator in `token-count.js` (`APPROX_TEXT_UNITS_PER_TOKEN = 4`) is the single change-point if the chars-per-token ratio ever moves; the compaction char budget (`STATE_SNAPSHOT_COMPACTION_TARGET_CHARS = 1056`) is sized to match it.
- `src/core/token-budget/` pre-counts source-relative sizing for L0/regen calls and builds a `<summaryception_source_budget>` prompt block. `budget-hint-builder.js` renders bounds through `applySafetyGap` (`safety-gap.js`, ratio 0.9), so the numbers the model sees are ~90% of the real validation bounds while ceilings (300 / 330) stay unchanged — overshoot into the gap still passes validation. `structural-constraints.js` adds source-derived caps (STATE lines `min(keys||7,7)`; NARRATIVE sentences `clamp(ceil(tokens/500),3,5)`) framed with equal weight to the token budget. `repair-feedback-adapter.js` appends a line/sentence-count line to repair feedback alongside the token diagnostics. The hint is pre-computed in `summarizer-pipeline.js` `attachBudgetHin…
- Snapshot state uses fixed continuity fields, a 300-token generated-output ceiling, and a 1,200-character injection safeguard. Legacy chats fall back to recognized fields from only the newest three Layer 0 snippets until their first snapshot is written.
- Layers 1+ promote older snippets. Narrative is LLM-compressed by moderate macro priorities: durable transitions, names/places needed for continuity, lasting agreements, current position, and unresolved hooks survive; brands, errands, meals, clothing, one-off supplies, dialogue, and mechanical scene replay are dropped. Source-size compression accounting counts source narratives only; rolling states remain contextual input. Snapshot sources use the final snapshot in the promoted span, not merged or carried into a complete remaining snapshot.
- Promotion uses 40% narrative soft target and 60% hard maximum, starts only for over-limit layers, and merges at least configured `snippetsPerPromotion` (defensively no fewer than three). `summarizer-promotion.js` owns quota details and reports when token pressure cannot progress because the minimum batch is unavailable.
- Any change to `store.layers`, snippet text/metadata, or related committed summary state must bump mutation epoch.

## Planning and execution

- `partition-planner.js` splits Layer 0 sources on assistant-turn boundaries using token-balanced partitions.
- `summarization-routes.js` normalizes Standard, Cache, Force, and Slop plans. Planner-specific countability stays inside planner modules.
- Cache auto-flush summarizes all planned partitions before one atomic commit, feeding each pending snapshot into the next partition's context. Force and Slop keep sequential partial commits.
- Shared route execution and promotion loops live in `summarizer-engine.js`; queue lifecycle in `summarizer-queue.js`.
- Prompt-affecting commits/effects queue while SillyTavern foreground generation is active. Generation end flushes pending work through `summarizer-commit.js`.
- Request-only prompt rewrites use `GENERATE_AFTER_DATA`, mutate final payload in place, and never persist rewritten roles/content into chat history. User-role masking applies to every outgoing `role: "user"` block, with marker-first, rewrite-all, marker-last, and keep-last-user modes; debug mode reports changed/kept counts in one collapsed console group with bounded content previews.

## Connections

- Adapters live in `src/core/connection-*.js`; `connectionutil.js` resolves routes and shared access.
- OpenAI-compatible SSE reads must reach `data: [DONE]`. EOF or disconnect before marker is retryable failure.
- Retry policy uses exponential backoff. Hard network failures such as `failed to fetch` or `ECONNREFUSED` skip normal primary retries and try configured fallback immediately.
- Per-attempt request timeout is configurable per route, stored in seconds on settings (`requestTimeoutSeconds` / `mergeRequestTimeoutSeconds` / `fallbackRequestTimeoutSeconds`) and resolved in `computeAttemptTimeoutMs` from `metadata.kind` + `metadata.useFallback`, not from the active connection. Retry attempts run at 75% of the first attempt's timeout so routes give up sooner to failover. Unset/invalid values fall back to hardcoded defaults (120s/90s layer0, 90s/60s promotion).
- Keep each connection source independently testable.

## Injection and ghosting

- `memory-injection.js` compiles one current-state block plus chronology. `memory-budget.js` applies injected-memory budget.
- Effective injected memory uses compact `[start-end@YYYY-MM-DDTHH]` chronology anchors; summarizer and promotion context retain verbose anchors, and budget accounting follows the compact rendered form.
- Direct placement uses `setExtensionPrompt()`. Macro Only exposes `{{summaryception_memory}}` and clears direct injection.
- Ghosting uses SillyTavern `/hide`; originals stay visible in chat UI. Ownership tracked by `extra.sc_ghosted` and `store.ghostedIndices`.
- Clearing uses `/unhide` only for Summaryception-owned ranges. Reconciliation repairs missing ownership/visual hides and trims invalid indices.

## Prose date-format contract

- `[NARRATIVE]` prose dates must be calendar form only (`On July 6`): no year, no ISO syntax, no clock-time lead-in. The current year and exact hour are already carried by the `[STATE]`/scene-time `current_date_time` anchor and the JSON `currentDateTime` field — duplicating them into prose wastes tokens and causes per-entry opener drift (`On July 6, 2024,` / `On 2024-07-06,` / `On July 6 at 19:00` all appeared before the rule). A clock time may appear once mid-sentence only when it carries story weight (alarm, deadline, shift boundary).
- Enforced by one shared constant `PROSE_DATE_FORMAT_RULE` (`src/foundation/prompt-constants.js`). It is imported by `layer0-compression.js` and appended via `appendLayer0PromptConstraints` and `appendPromotionPromptConstraints`, plus embedded in all four default prompts (`DEFAULT_SUMMARIZER_USER_PROMPT`, `DEFAULT_SUMMARIZER_REPAIR_PROMPT`, `DEFAULT_PROMOTION_USER_PROMPT`, `DEFAULT_PROMOTION_REPAIR_PROMPT`). The Layer 0 and Layer 1+ generate/repair sites must all use the same constant — do not inline a date-format spec in only one site (that is how the prior ISO-in-prose contradiction, e.g. the old `2024-07-12 Fri` example, leaked ISO dates into promotion prose).
