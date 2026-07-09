# Summaryception

Layered recursive memory for SillyTavern.

Summaryception is for long roleplay chats that should remember what happened without shoving the whole backstory into every prompt. It runs as a plain browser extension inside [SillyTavern](https://github.com/SillyTavern/SillyTavern). No build step, no server, no database.

The short version: recent chat stays verbatim. Older chat becomes compact memory. The original messages stay in the chat UI, but Summaryception hides them from the model once they are covered by memory.

## Why this exists

Long chats usually fail in one of two boring ways.

You keep too much raw chat, so every generation drags a huge pile of old prose through the context window. Or you keep one normal summary, watch it blur details together, and start adding more raw chat again to compensate.

Summaryception takes the other route. It summarizes older chat in small pieces, then summarizes those summaries again when they pile up. The result is a memory stack: recent text at the bottom, compact turn summaries above it, deeper summaries above those.

```text
Current chat
|
|  Older messages: ghosted from the model, still visible to you
|  Recent messages: sent word for word
|
|  Injected memory:
|
|  Layer 2+  deep memory from promoted summaries
|  Layer 1   merged Layer 0 summaries
|  Layer 0   direct summaries of chat turns
|  Verbatim  the live recent window
```

That sounds abstract until you hit a 2,000 message chat and the model still remembers who promised what, who is injured, where the party left the key, and which subplot was quietly waiting in the corner.

## What it does

- Keeps a rolling verbatim window for recent chat.
- Compresses older chat into Layer 0 memories.
- Promotes older Layer 0 memories into deeper layers when the layer gets crowded.
- Separates narrative continuity from durable state using `[NARRATIVE]` and `[STATE]`.
- Ghosts summarized messages with SillyTavern's `/hide`, so they stop reaching the model but remain readable in the UI.
- Injects the assembled memory through SillyTavern extension prompts, or exposes it as `{{summaryception_memory}}` for custom prompt layouts.
- Runs background summarization without mutating the prompt during an active generation.

## Install

Requirements: SillyTavern 1.16.0 or newer.

In SillyTavern:

1. Open Extensions.
2. Choose Install Extension.
3. Paste `https://github.com/vadash/Extension-Summaryception`.
4. Install, then open Summaryception in extension settings.

## First setup

Start with Easy mode unless you already know what you want to tune.

Set Fast Summarizer to your normal API or a SillyTavern Connection Profile. This model handles raw chat to Layer 0 summaries, so it should be cheap, fast, and good enough at extracting facts.

Smart Deep Memory is optional. Use it when you want Layer 1+ merges to use a stronger model than the raw-chat summarizer.

Then pick a memory style:

- Standard keeps the main prompt smaller and summarizes overflow continuously.
- Cache Friendly keeps a larger live window and a stable memory prefix for providers with prompt caching discounts.

The defaults are intentionally conservative: 22k recent verbatim tokens, 10k injected memory, 200 token Layer 0 targets, and promotion after old memories stack up.

## Controls you will actually use

Force Summarize processes eligible old chat now instead of waiting for the background worker.

Slop Breaker is for the moment when the model starts repeating itself or gets stuck in a bad format. It summarizes through the current live context cut, ghosts that text, and forces the next generation to work from compact memory instead of stale phrasing.

Stop cancels the current summarization run.

Clear removes Summaryception memory for the current chat and unghosts messages Summaryception owns. It does not delete chat messages.

## Advanced mode

Advanced mode exposes the knobs Easy mode hides:

- Verbatim and injected memory token budgets.
- Layer 0 batch sizes and source token caps.
- Memories per layer and memories per merge.
- Memory placement: Before Prompt, In Prompt, In Chat, or Macro Only.
- Memory role: system, user, or assistant.
- Separate prompts for Layer 0 summaries, Layer 1+ promotions, and repair attempts.
- Regex cleanup, Chinese ideograph stripping, debug logs, trace logs, and prompt I/O logs.

Macro Only is useful when your prompt already has a deliberate memory slot. Add `{{summaryception_memory}}` where you want the assembled memory to appear.

## Connection routes

Summaryception can use:

- SillyTavern's active main API.
- SillyTavern Connection Profiles.
- Ollama.
- OpenAI-compatible endpoints.

There are three routes:

- Layer 0 for new raw-chat summaries.
- Merge for deeper Layer 1+ promotion work.
- Fallback for retryable failures after the primary route gives up.

OpenAI-compatible local endpoints may need SillyTavern's CORS proxy. Streaming responses must finish with `data: [DONE]`; incomplete streams are treated as failed attempts.

## Slash commands

`/sc-status` shows the current summarized index and layer counts.

`/sc-preview` prints the memory block that would be injected.

`/sc-clear` clears Summaryception memory for the current chat and unghosts Summaryception-owned messages.

## Safety notes

Summaryception is designed to be non-destructive. Summaries live in chat metadata. Settings live in extension settings. Ghosted messages are marked with `extra.sc_ghosted`, so the extension can tell its own hidden messages apart from messages you hid yourself.

If something looks off, use Clear or `/sc-clear`. That removes Summaryception's memory and ownership flags for the current chat, then unghosts the messages it owns.

## Latest changelog

### v16.4.0

- Refactored summarization routing so Standard, Cache Friendly, Force Summarize, and Slop Breaker use one normalized route plan.
- Split memory style from memory placement. Choosing Standard or Cache Friendly is no longer tangled with where the memory block is injected.
- Added assistant role masking for chat-completion requests. When enabled, text-only user-role prompt blocks are rewritten as assistant-role blocks for the outgoing request only. Saved chat is not edited.
- Cleaned up tuning UI and help text around context estimates, cache behavior, and memory placement.

Older notes before v16 are intentionally trimmed here. The current README tracks the latest release line instead of carrying a long stale changelog.

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/f1fda4c0-282e-4bbf-8924-98755fb461e0" width="180" alt="1" />
  <img src="https://github.com/user-attachments/assets/988a1227-7c43-4512-8256-67e8a98a8689" width="180" alt="2" />
  <img src="https://github.com/user-attachments/assets/515f7249-6b29-402f-9979-120e9cbfd336" width="180" alt="3" />
  <img src="https://github.com/user-attachments/assets/cd7a255c-4d52-4082-9e62-af6c40798a0a" width="180" alt="4" />
  <img src="https://github.com/user-attachments/assets/88f5de03-4414-4b7d-8b1a-3bfa60b5d3f8" width="180" alt="5" />
</p>

## License

AGPL-3.0. See [LICENSE](LICENSE).
