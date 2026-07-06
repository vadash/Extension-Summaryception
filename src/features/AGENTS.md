# Features Layer

This directory connects `core` logic to form discrete workflows (Snippet Management, Memory Clearing, Chat Repair, and Injection).

## Rules
- **Injection:** Uses `setExtensionPrompt()` utilizing the last committed summary snapshot.
- **Persistence:** `persistChatState()` saves metadata immediately. Deferred chat-file saves must be flushed at worker/manual boundaries, never on unload.
- **Maintenance:** Legacy disable-hiding saves are ignored; repair scripts should visually hide Summaryception-owned metadata ghosts.
- **Workflow ownership:** Snippet editing/deleting/regenerating and orphaned message repair live here, return compact status objects, and leave toastr wording/UI refresh decisions to `src/entry/`.
