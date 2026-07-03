# Minimal Stability Refactor For Summaryception Persistence

## Goal

Make saved memory recover cleanly after reloads and partial shutdowns without adding a transaction system, durable job queue, or unload-handler complexity.

## Scope

- Normalize `chatMetadata.summaryception` through `getChatStore()`.
- Reconcile loaded chats on app ready and chat change: normalize, repair branch drift, update injection, then repair missing ghosting.
- Use existing `ghostMessagesUpTo(store.summarizedUpTo)` for ghost repair.
- Make ghost cleanup use both stored `ghostedIndices` and message `extra.sc_ghosted` flags.
- Persist chat state when message flags change; reserve `saveChatStore()` for metadata-only edits.
- When deleting a Layer 0 snippet, unghost its source range and recalculate `summarizedUpTo` from contiguous Layer 0 coverage.

## Non-Goals

- No persisted in-flight summarizer results.
- No `beforeunload`, localStorage queues, schema version migrations, or transaction framework.
- Prefer recovery on next load or chat change over making every browser-close timing atomic.

## Acceptance

- Add focused Vitest coverage for malformed metadata, ghost cleanup drift, startup reconciliation, and committed-summary reload repair.
- Run `npm test`.
