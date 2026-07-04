# Token-Budget-Driven Verbatim Window Plan

## Summary

Layer 0 summarization uses a dynamic verbatim window. The goal is to keep a consistent amount of recent raw chat in the LLM context for style continuity, while batching older overflow into useful summary-sized chunks.

## Settings

- `verbatimTokenBudget`: slider, default `16000`, min `4000`, max `64000`, step `1000`.
- `minSummaryBudget`: slider, default `6000`, min `2000`, max `16000`, step `1000`.
- `minSummaryTurns`: slider, default `3`, min `2`, max `10`, step `1`.
- `maxSummaryTurns`: slider, default `5`, min `3`, max `10`, step `1`; must be greater than or equal to `minSummaryTurns`.
- Legacy `turnsPerSummary` and `verbatimTurns` are not migrated; missing new keys reset to these defaults.

## Runtime Behavior

- Count all prompt-visible, non-ghosted, non-empty user and assistant messages when checking `verbatimTokenBudget`.
- If regex scripts are enabled, apply the same regex pipeline used for summary passages before counting budget tokens.
- Assistant turns older than the `verbatimTokenBudget` boundary become Layer 0 overflow candidates.
- Summarize when overflow candidates contain at least `minSummaryTurns` and their contiguous passage has at least `minSummaryBudget` regex-adjusted tokens.
- If overflow candidates reach `maxSummaryTurns`, summarize that batch even if `minSummaryBudget` is not met, so short-message chats cannot stall forever.
- Batch size is capped at `maxSummaryTurns`.
- The selected assistant batch determines the newest endpoint only; the committed Layer 0 passage remains contiguous from `summarizedUpTo + 1` through that endpoint.

## Integration

- Auto worker, Force Summarize, catch-up, and UI backlog status use the same shared overflow selector.
- Catch-up recomputes the selector after every committed batch.
- Promotion runs only when no Layer 0 batch is ready.
- Missing ghosting repair remains active when overflow exists but all relevant assistant turns are already summarized.

## Acceptance Tests

- New settings default and clamp correctly.
- `maxSummaryTurns >= minSummaryTurns` is enforced.
- Verbatim budget counts user and assistant messages.
- Regex-adjusted counts can prevent a verbatim overflow that raw text alone would cause.
- Soft overflow waits for both `minSummaryTurns` and `minSummaryBudget`.
- `maxSummaryTurns` prevents short overflow batches from stalling indefinitely.
- Irregular `U B B U U B` style chats still produce contiguous summary passages.
