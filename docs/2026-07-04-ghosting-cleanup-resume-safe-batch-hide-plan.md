# Ghosting Cleanup And Resume-Safe Batch Hide Plan

## Summary

Refactor ghosting as a focused durability cleanup. Use SillyTavern slash range batching for hide and unhide work, while treating refresh or tab close as an interruption that must be repaired on the next app or chat load.

## Key Changes

- Keep existing ghosting exports as wrappers, backed by range-oriented internals.
- Ghost only the newly committed summary passage range instead of `0..endIdx`.
- Build contiguous `/hide a-b` and `/unhide a-b` ranges after filtering out user, system, empty, user-hidden, and already completed messages.
- Before each hide range, mark Summaryception ownership with `sc_ghosted` and `ghostedIndices`, persist that checkpoint, then run the slash command.
- Repair on app or chat load from saved summary ranges, `summarizedUpTo`, `ghostedIndices`, and `sc_ghosted`.
- Serialize and debounce chat-load reconciliation so save/hide bursts do not launch overlapping repair passes.
- Keep routine ghosting quiet; reserve progress toasts for manual import or clear workflows.

## Recovery Model

- Refresh during an LLM request before commit saves no summary; the next run retries normally.
- Refresh after a summary commit but before or during ghosting leaves a saved summary; startup repair finishes missing hides without duplicating the summary.
- Refresh after ownership flags are checkpointed but before visual hide completes leaves resumable metadata; startup repair hides only missing eligible messages.
- No unload-time async cleanup is attempted.

## Test Plan

- Expect batched slash commands such as `/hide 0-2`, not one call per message.
- Verify holes split ranges so user, system, empty, user-hidden, and already hidden messages are not included.
- Verify interrupted states: summary saved with missing flags, flags saved before visual hide, and partial visual hide.
- Verify batched `/unhide a-b` only for Summaryception-owned messages.
- Verify repeated `onChatChanged()` calls collapse into a single reconciliation pass.
- Per repository instructions, do not run `npm test` unless explicitly requested.
