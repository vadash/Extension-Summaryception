# Core Engine & Architecture

This directory houses the background worker, LLM connections, token counting, and memory processing logic.

## Memory & Layers
- **Layer 0:** Turn summaries selected by the dynamic verbatim window. Overflow waits for `minSummaryTurns` and `minSummaryBudget`.
- **Runtime compression controls:** Keep L0/regeneration and promotion prompt constraints plus provider output caps routed through `layer0-compression.js`; custom prompts still need these non-persisted runtime constraints.
- **Layers 1+:** Meta-summaries promoted from lower layers.
- **Promotion:** Only merge an over-limit layer once it has at least `snippetsPerPromotion` snippets; underfilled layers may temporarily exceed quota, and non-compressing promotion output must not be committed.
- **Dual-track memory:** L0/regeneration stored output must preserve `[NARRATIVE]`/`[STATE]` markers for `summarizer-state.js`; promotions send narrative text to the LLM and merge `[STATE]` data with `mergeStates()` in code.
- **Regex:** Apply SillyTavern regex scripts only while rendering chat passages into Layer 0 or regeneration source text; promotion inputs are synthetic memory and must not be regexed.
- **Ghosting:** Ghosted messages are hidden from the LLM context using SillyTavern's native `/hide` command, but remain fully visible in the UI.

## Engine & Summarizer
- `summarizer-engine.js` owns the Auto, Force, Slop, and Cache execution loops.
- Background summarization is coalesced through a single self-draining worker (`SummarizerQueue`).
- Prompt-affecting commits/effects must be queued during SillyTavern foreground generation to avoid race conditions.

## LLM Connections
- Connection backends are provider adapters registered in `src/core/connectionutil.js`.
- Pass summarizer `AbortSignals` to direct fetch adapters and Connection Manager profiles.
- SSE stream readers must treat incomplete streams as failed attempts: abort signals propagate unchanged, read failures throw retryable errors, and streams MUST reach `data: [DONE]` before any text is accepted.
- Summarizer calls use exponential backoff, up to 3 retries per route, spanning 2s-60s delays.
- Primary retry-exhaustion health is tracked separately for Layer 0 calls and L1+ promotion calls; do not let one bucket force early fallback for the other.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.
