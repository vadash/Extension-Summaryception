# Slop Breaker And Manual Reload UX

## Goal

Add a manual Slop Breaker operation that summarizes the current unsummarized live tail, including the verbatim window, and reload after successful manual cuts so SillyTavern rebuilds prompt state from committed metadata.

## Behavior

- Force Summarize keeps using the dynamic verbatim-window backlog planner.
- Force Summarize reloads only when at least one batch was committed and the run was not canceled or blocked.
- Slop Breaker captures a fixed target index before it starts:
  - If the latest countable message is assistant, summarize through it.
  - If the latest countable message is user, preserve exactly that latest user message and summarize through the previous countable message.
- Slop Breaker requires at least one assistant message in the target range.
- Slop Breaker ignores verbatim budget and minimum summary thresholds, but still caps each request by `maxSummaryTurns`.
- Slop Breaker reloads only when the intended target cut is fully committed.
- Abort, total failure, disabled/no-op states, and foreground-generation blocks do not reload.

## UX

- Force Summarize tooltip: `Summarize backlog outside the verbatim window. Keeps recent chat live.`
- Slop Breaker tooltip: `Summarize the live context too. Use when the AI is stuck repeating patterns.`
- Slop Breaker uses a `fa-broom` Operations button and a confirmation modal titled `Run Slop Breaker?`.
- Slop Breaker no-op toast: `Nothing to reset yet. Wait for an AI reply first.`

## Verification

- Unit coverage for Slop Breaker target selection, trailing-user preservation, capped batches, final below-cap batches, no-op states, source endpoint commits, and manual-run reload outcomes.
- Run `npm test` for behavior verification.
