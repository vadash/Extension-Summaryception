# Dry-run preview owns its viewer instead of hooking PromptInspector

The Dry-Run Preview renders in its own Summaryception viewer module behind the `CHAT_COMPLETION_PROMPT_READY` seam, cloning PromptInspector's `Popup` pattern but leaving that extension untouched: PromptInspector exposes no exports, renders textareas only, and explicitly skips dry runs, so any reuse would mean localStorage toggle hacks or spoofed events.

## Considered Options

- **Hook or patch PromptInspector** — rejected: closure-private display, no image rendering, dry-run early return, in-place mutation of the live payload.
