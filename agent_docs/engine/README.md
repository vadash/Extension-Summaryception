# Engine

## Memory model

- Layer 0 summarizes turns selected beyond dynamic verbatim window. Valid output preserves `[NARRATIVE]` and `[STATE]` sections.
- `layer0-compression.js` enforces target-length bands after cleanup and integrity validation. Provider output caps are separate; never derive them from `layer0SummaryTokenTarget`.
- Layers 1+ promote older snippets. Narrative is compressed by LLM; structured state is parsed and merged in code by `summarizer-state.js`, then carried forward without raw repetition.
- Promotion starts only for over-limit layers and merges at least configured `snippetsPerPromotion`. `summarizer-promotion.js` owns quota details.
- Any change to `store.layers`, snippet text/metadata, or related committed summary state must bump mutation epoch.

## Planning and execution

- `partition-planner.js` splits Layer 0 sources on assistant-turn boundaries using token-balanced partitions.
- `summarization-routes.js` normalizes Standard, Cache, Force, and Slop plans. Planner-specific countability stays inside planner modules.
- Cache auto-flush summarizes all planned partitions before one atomic commit. Force and Slop keep sequential partial commits.
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
- Direct placement uses `setExtensionPrompt()`. Macro Only exposes `{{summaryception_memory}}` and clears direct injection.
- Ghosting uses SillyTavern `/hide`; originals stay visible in chat UI. Ownership is tracked by `extra.sc_ghosted` and `store.ghostedIndices`.
- Clearing uses `/unhide` only for Summaryception-owned ranges. Reconciliation repairs missing ownership/visual hides and trims invalid indices.
