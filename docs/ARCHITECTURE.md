# Core Architecture & Engine

This document details the internal mechanics of Summaryception's summarization engine, memory management, and SillyTavern integration.

## 1. Unified Elastic Summarization & Promotion
Summaryception uses a single elastic execution engine (`SummarizerQueue`) for all tasks. Strategy-specific code supplies boundaries, while the engine owns execution, commits, promotion pressure, and foreground freeze handling.

### Execution Strategies
- **AUTO:** Normal chat summarization. Respects dynamic verbatim window, `minSummaryTurns`, `minSummaryBudget`, and `maxSummaryTurns`.
- **FORCE:** Uses the same live-tail boundary as AUTO but ignores minimum readiness to summarize existing overflow immediately.
- **SLOP:** Summarizes completed exchanges through the latest assistant/complete message. Used when the AI is stuck in a loop.
- **CACHE:** Delays the first Layer 0 batch until the cache live-window threshold is exceeded, then uses the same one-batch loop.

### The KISS Promotion Loop
All modes use the same loop:
`Re-evaluate state -> Promote if any promotable layer is over limit -> Otherwise commit one Layer 0 batch -> Repeat`
- A layer is promotable only when it exceeds its dynamic token quota or `snippetsPerLayer` and has at least `snippetsPerPromotion` snippets.
- Underfilled layers, including a single oversized snippet, may temporarily exceed quota because promoting them would be lossy or impossible.
- Promotions that do not reduce memory size are rejected and left uncommitted; debug logs show `memory=before->after` for promotion calls.
- Never start new Layer 0 work while any promotable layer exceeds its dynamic token quota or `snippetsPerLayer`.
- There is no "free" seed promotion. Empty destination layers are created by LLM-backed merge promotion.
- Maximum Layer Depth is capped internally at 20.

## 2. Token-Budget-Driven Verbatim Window
Layer 0 summarization uses a dynamic verbatim window to keep recent chat raw for style continuity.
- **Verbatim Token Budget:** Default 16k. Assistant turns older than this boundary become Layer 0 overflow candidates.
- **Regex Processing:** If `applyRegexScripts` is enabled, SillyTavern's regex pipeline is applied *before* counting budget tokens.
- **Batching:** Soft overflow waits for both `minSummaryTurns` and `minSummaryBudget`. However, if `maxSummaryTurns` is reached, it summarizes immediately to prevent short-message chats from stalling indefinitely.

## 3. Cache Friendly Memory Mode
Cache mode keeps the prompt shape stable (`Prompt | frozen memory | growing live chat`) so provider prefix caching can reuse the stable prefix across many turns.
- **Verbatim Budget:** Increases to 32,000.
- **Algorithm:** Protects a live tail of `4000` to `8000` tokens (calculated as 20% of the verbatim budget). Once the unghosted live chat exceeds the verbatim budget, it flushes older chat in capped Layer 0 batches.

## 4. Ghosting & Reconciliation
Ghosting hides processed messages from the LLM using SillyTavern's native `/hide` commands while keeping them visible in the UI.
- **Batching:** Builds contiguous `/hide a-b` and `/unhide a-b` ranges after filtering out user, system, empty, and already hidden messages.
- **Ownership:** Messages are marked with `sc_ghosted` and tracked in `ghostedIndices`.
- **Resilience:** If the UI refreshes before visual hiding completes, startup repair (`ghosting-reconcile.js`) catches the missing `/hide` commands based on the saved metadata. Unload-time async cleanup is intentionally avoided.

## 5. Background Summarization & Prompt Guard
- **Foreground Freeze:** On `GENERATION_STARTED`, prompt-affecting mutations are frozen. Completed background summaries are held as pending commits.
- **Queue Coalescing:** The worker drains ready work continuously. If a user sends a message during an in-flight request, it is marked `dirty = true` and recomputed after the current batch finishes.
- **Flush:** On `GENERATION_ENDED`, pending commits are flushed, injection is updated, and deferred ghosting (`/hide`) is applied.

## 6. SillyTavern Context Facade
`src/foundation/context.js` is a thin, defensive facade over `SillyTavern.getContext()`. 
- Every other module imports from here instead of touching the `SillyTavern` global directly.
- Missing fields return `null` or safe fallbacks instead of throwing.
