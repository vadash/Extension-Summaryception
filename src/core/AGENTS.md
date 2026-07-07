# Core Engine & Architecture

This directory houses the background worker, LLM connections, token counting, and memory processing logic.

## Memory & Layers
- **Layer 0:** Turn summaries selected by the dynamic verbatim window. Overflow waits for `minSummaryTurns` and `minSummaryBudget`.
- **Temporal metadata:** New snippets may carry `sourceRange` plus hour-level `timelineStart`/`timelineEnd`/`currentDateTime`; chronology/promotion anchors must use this metadata only, with no legacy `turnRange` backfill.
- **Auto/Force/Slop/Cache:** Auto respects the live-tail window and readiness minimums; Force uses the same boundary but ignores minimum readiness; Slop cuts completed live exchanges through the latest assistant message; Cache delays the first L0 batch until the cache live-window threshold is exceeded.
- **Cache mode:** Keep prompt shape stable as `Prompt | frozen memory | growing live chat`; the verbatim budget is 32k, with a 4k-8k protected live tail before older unghosted chat flushes in capped L0 batches.
- **Runtime compression controls:** Keep L0/regeneration and promotion prompt constraints plus provider output caps routed through `layer0-compression.js`; custom prompts still need these non-persisted runtime constraints.
- **Layers 1+:** Meta-summaries promoted from lower layers.
- **Memory budget:** `memoryTokenBudget` tracks the assembled Summaryception injection size; use `memory-budget.js`/`memory-injection.js` instead of raw snippet text when changing budget UI or promotion pressure. Promotion pressure uses the hardcoded pyramid gates, with L0 current-state tokens charged to L0 and L2+ counted as one aggregate bucket.
- **Promotion:** Only merge an over-limit layer once it has at least `snippetsPerPromotion` snippets; underfilled layers may temporarily exceed quota, non-compressing promotion output must not be committed, empty destination layers are created only by LLM-backed merge promotion, and maximum depth is capped at 20. L0 promotion must not drain projected effective L0 usage below 40% of its quota; when L0 is promoted, carry durable active state into the oldest remaining L0 snippet rather than making L1+ current-state sources.
- **Dual-track memory:** L0/regeneration stored output must preserve `[NARRATIVE]`/`[STATE]` markers for `summarizer-state.js`; `compileGlobalState()` reads only L0. L1+ promotions must store narrative-only prose by folding durable source state into prose and stripping any `[STATE]` output; legacy L1+ state is rendered only as bracketed historical chronology notes, not current state.
- **Composite state merging:** `mergeStates()` does sub-entry merging for `characters`, `inventory`, `counters`, `dynamics`, and `hooks` keys when both old and new values are structured `name: value; ...` pairs; older sub-entries not reasserted in the newer state are preserved, and sub-entry nullifiers (e.g. `Bob: removed`) remove only the matching sub-entry. Values without structured colons fall back to whole-value overwrite.
- **Regex:** Apply SillyTavern regex scripts only while rendering chat passages into Layer 0 or regeneration source text; promotion inputs are synthetic memory and must not be regexed.
- **Ghosting:** Ghosted messages are hidden from the LLM context using SillyTavern's native `/hide` command, but remain fully visible in the UI; batching builds contiguous `/hide` and `/unhide` ranges after filtering user, system, empty, and already hidden messages, with ownership tracked by `sc_ghosted` and `ghostedIndices`.

## Engine & Summarizer
- `summarizer-engine.js` owns the Auto, Force, Slop, and Cache execution loops.
- Background summarization is coalesced through a single self-draining worker (`SummarizerQueue`).
- Prompt-affecting commits/effects must be queued during SillyTavern foreground generation; pending commits flush on generation end with injection updates and deferred ghosting.
- In-flight summary/promotion commits validate `store.mutationEpoch`; any code that changes `store.layers` or snippet fields must call `bumpSummaryStoreMutationEpoch()`.
- If chat changes while a summarizer request is in flight, mark the queue dirty and recompute after the current batch rather than starting parallel work.

## LLM Connections
- Connection backends are provider adapters registered in `src/core/connectionutil.js`.
- Merge/fallback routes inherit shared endpoint credentials from base settings, but provider-specific tunables such as profile IDs, model names, and token caps reset to route defaults unless prefixed overrides are set.
- Pass summarizer `AbortSignals` to direct fetch adapters and Connection Manager profiles.
- SSE stream readers must treat incomplete streams as failed attempts: abort signals propagate unchanged, read failures throw retryable errors, and streams MUST reach `data: [DONE]` before any text is accepted.
- Summarizer calls use exponential backoff, up to 3 retries per route, spanning 2s-60s delays. Hard network failures (`failed to fetch`, `ECONNREFUSED`, DNS failures) skip retries and trigger immediate fallback when configured; if both primary and fallback fail, wait with abort-aware backoff before resetting health and restarting from primary.
- Primary retry-exhaustion health is tracked separately for Layer 0 calls and L1+ promotion calls; do not let one bucket force early fallback for the other.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.
