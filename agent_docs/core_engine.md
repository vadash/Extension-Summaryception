# Core Engine & LLM Connections

## Memory Layers & State

- **Layer 0 (L0):** Turn summaries selected by the dynamic verbatim window. Output preserves `[NARRATIVE]` and `[STATE]` markers.
- **Layers 1+ (L1+):** Meta-summaries promoted from lower layers. They fold durable state into narrative continuity.
- **Promotion:** Only merges when an over-limit layer has `>= snippetsPerPromotion`.
- **Atomicity:** Any code that changes `store.layers` or snippet fields must call `bumpSummaryStoreMutationEpoch()`.

## Engine execution

- Prompt-affecting commits/effects queue during SillyTavern foreground generation to avoid prompt mutation freezes. Pending commits flush on generation end.
- `partition-planner.js` ensures L0 batches never spike by token-balancing source partitions.
- Shared execution loops live in `summarizer-engine.js`.

## LLM Connections

- Connection adapters are in `src/core/connectionutil.js`.
- SSE stream readers must treat incomplete streams as failed attempts (must reach `data: [DONE]`).
- Summarizer calls use exponential backoff. Hard network failures (`failed to fetch`, `ECONNREFUSED`) skip retries and trigger immediate fallback if configured.

## Ghosting

- We hide original messages from the LLM using SillyTavern's `/hide` command, while keeping them visible in the UI. Tracked by `sc_ghosted` and `ghostedIndices`.
