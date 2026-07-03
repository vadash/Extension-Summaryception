# Targeted Background Summarization Hardening

## Summary

This refactor keeps the single coalescing background worker, but makes it drain ready work continuously instead of waiting for another chat event after each batch. In-flight summarizer requests continue during foreground generation; prompt-affecting commits and effects are deferred until generation ends.

## Key Changes

- Recompute chat state after every successful background batch.
- Continue layer-0 batches until visible assistant turns are within `verbatimTurns`.
- Process layer promotions after layer-0 overflow is stable.
- Yield briefly between worker cycles so UI and generation events can run.
- Stop background draining on failure, disabled or paused settings, foreground freeze, pending commits, or pending prompt effects.
- Treat injection updates and ghosting as guarded prompt effects.
- Prevent new `setExtensionPrompt()` or `/hide` calls from starting while foreground generation is frozen.
- Re-check the generation epoch at async boundaries in commit and ghosting flows.
- Queue remaining ghosting work if generation starts midway through an async hide sequence.

## Constraints

- No persisted metadata schema change.
- Keep public exports such as `requestSummarization()`, `abortSummarization()`, `getIsSummarizing()`, `beginForegroundGeneration()`, and `endForegroundGeneration()`.
- Do not parallelize layer-0 summarizer calls; each batch depends on the previous committed summary context.
- Do not parallelize promotions; layer structure must remain ordered.
- Prefer temporary duplicate context over missing context when exact all-or-nothing `/hide` atomicity is unavailable.

## Verification

- Existing `npm test` must remain green.
- Add worker coverage for continuous auto drain across multiple layer-0 batches without new message events.
- Add freeze coverage proving completed summaries do not call injection or hide effects while frozen.
- Add mid-ghost freeze coverage proving remaining hides are deferred and flushed after generation ends.
- Add promotion coverage proving queued promotion commits update injection only after unfreeze.
- Add stale-result coverage for deferred commits after chat and summary-store changes.
