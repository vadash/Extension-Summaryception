# Core Engine & Architecture

This directory houses the background worker, LLM connections, token counting, and memory processing logic.

## Memory & Layers
- **Layer 0:** Turn summaries selected by the dynamic verbatim window. Overflow waits for `minSummaryTurns` and `minSummaryBudget`.
- **Layers 1+:** Meta-summaries promoted from lower layers.
- **Ghosting:** Ghosted messages are hidden from the LLM context using SillyTavern's native `/hide` command, but remain fully visible in the UI.

## Engine & Summarizer
- `summarizer-engine.js` owns the Auto, Force, Slop, and Cache execution loops.
- Background summarization is coalesced through a single self-draining worker (`SummarizerQueue`).
- Prompt-affecting commits/effects must be queued during SillyTavern foreground generation to avoid race conditions.

## LLM Connections
- Connection backends are provider adapters registered in `src/core/connectionutil.js`.
- Pass summarizer `AbortSignals` to direct fetch adapters and Connection Manager profiles.
- SSE stream readers must treat incomplete streams as failed attempts: abort signals propagate unchanged, read failures throw retryable errors, and streams MUST reach `data: [DONE]` before any text is accepted.
- Summarizer calls use exponential backoff, up to 5 retries, spanning 2s-60s delays.
- Primary retry-exhaustion health is tracked separately for Layer 0 calls and L1+ promotion calls; do not let one bucket force early fallback for the other.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.
