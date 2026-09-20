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
- Keeps each memory a single `[NARRATIVE]` prose section with a trailing `current_date_time` scene-time line.
- Ghosts summarized messages with SillyTavern's `/hide`, so they stop reaching the model but remain readable in the UI.
- Injects the assembled memory through SillyTavern extension prompts, or exposes it as `{{summaryception_memory}}` for custom prompt layouts.
- Runs background summarization without mutating the prompt during an active generation.
- Optional Continuity Auditor keeps a live game-state in an `<active_continuity>` block next to the injected memory.

## Install

Requirements: the latest stable SillyTavern release.

In SillyTavern:

1. Open Extensions.
2. Choose Install Extension.
3. Paste `https://github.com/vadash/Extension-Summaryception`.
4. Install, then open Summaryception in extension settings.

## First setup

Start with Easy mode unless you already know what you want to tune.

Set Fast Summarizer to your normal API or a SillyTavern Connection Profile. This model turns raw chat into Layer 0 summaries, so it should be cheap, fast, and good enough at extracting facts.

Smart Deep Memory is optional. Point it at a stronger model if you want Layer 1+ merges to read better than what the raw-chat summarizer produces.

Then pick a memory mode. Your provider's cache rules decide whether Prefix Cache saves you money or just makes the prompt fatter.

### Balanced

The one to pick unless you have a reason not to. Balanced keeps recent chat near the 22k verbatim budget and summarizes overflow into a 6k queued range as it arrives. The goal is simple: keep the model inside a useful context range without relying on provider caching.

This mode works everywhere and keeps context size fairly steady. If cached input is not much cheaper than normal input, stop here. You are done.

### Prefix Cache

Use Prefix Cache with the normal prompt caches most providers offer. It holds a 36k live span: 20k verbatim plus a 16k queued range, so more of each request can stay cached.

Suppose the next request keeps the same start but changes the tail. A prefix cache can still reuse that unchanged start. Your usual lorebooks work normally; no migration or special outlet is needed.

Pick this mode when cached input is cheaper and your provider supports partial prefix reuse. The tradeoff is a larger prompt, and a summary flush also hands the provider a new prefix to cache.

One more knob matters here and only here. The cache TTL decides when Prefix Cache considers the provider cache expired: once the chat has sat idle longer than the TTL (default 30 minutes), loading it triggers a stale-cache suggestion to Force Summarize first. The next message pays full input price either way, so summarizing first avoids paying for the same tokens twice.

The defaults are intentionally conservative: 22k recent verbatim tokens, 10k injected memory, 280-token Layer 0 targets, and promotion after old memories stack up.

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

There are three routes:

- Layer 0 for new raw-chat summaries.
- Merge for deeper Layer 1+ promotion work.
- Fallback for retryable failures after the primary route gives up.

OpenAI-compatible local endpoints may need SillyTavern's CORS proxy. Since v20, summarization tasks do not use presets, so it does not matter what your connection is linked to.

## Continuity Auditor

Everything above is narrative memory: prose about what happened. The Continuity Auditor is the other half. It is an opt-in background call that audits each finished reply in solo chats and keeps a live game-state: positions, relationship bonds, NPC agendas, secrets. Off by default.

Why bother? Without it, keeping the story straight is the main model's job. It spends its output re-stating who stands where, how the relationship shifted, and which agenda moved, and that bookkeeping crowds out the scene itself. The Auditor does that bookkeeping outside the main model and hands the result back as a compact block, so replies come out shorter and more focused on what is actually happening. The block describes the last audited reply, so it runs one message behind the live chat.

Enable it under Continuity Auditor and give it a fast model. It runs after every reply, so latency matters more than brains here. Connection settings live under Models → Continuity Connections, separate from the summarizer routes: it inherits Layer 0 unless you point it elsewhere, and "Fall back to the Narrative Chain" lets it use the Layer 0 chain as last resort when both Auditor routes fail.

The game-state is four things:

- Scene and positioning: location, environment, posture, contact points, clothing.
- Bonds: one per character pair, with Sparks and Grudge. A high enough bond shows a gate: hug, handhold, kiss, intimacy.
- Agendas: each NPC's current task and step.
- Notes: short GM remarks, with `[S]` marking secrets some characters do not know.

The Auditor only reads and flags. All the math is done by code, and the result is stored on the audited reply as a checkpoint. The newest checkpoint is the live state.

### What the model gets

The live checkpoint is injected into the chat itself, near the newest messages, as a system block:

```text
<active_continuity>
[SCENE & POSITIONING]
Location: Old mill - upstairs loft
Environment: rain against the shutters, one lantern lit
Physics: Mira sitting on the windowsill, feet off the floor
Contact: Dave by the door, arms crossed
Clothing: Mira barefoot, coat still wet

[RELATIONSHIP GATES]
Mira & Dave: BOND +6 (Sparks: 2, Grudge: 0); Gate: handhold

[SECRETS & ASYMMETRIC KNOWLEDGE]
[S] Mira never actually lost the key

[ACTIVE AGENDAS & THREADS]
- Mira: find out who paid the mercs (Step 2/5: active)
- Dave: quiet about the second key
</active_continuity>
```

This is the real renderer's output shape: only non-empty sections appear, secret `[S]` notes get their own section, and ordinary GM notes render under agendas as active threads. Replies that have not been audited yet are covered by the last checkpoint, and the block says so until the Auditor catches up.

### The green check mark

Every audited reply gets a green ✓ after the character name in chat. The newest one also shows a ●. That reply holds the live checkpoint the injected block comes from. Swipe or regenerate the last reply and its checkpoint is dropped, so the check vanishes until the new answer gets audited.

### How it works with narrative memory

The layers summarize the story. The Auditor tracks the state. One knows what happened, the other knows what is true right now, and they share nothing at runtime: separate routes, separate prompt.

### Preset

Try it with [ff_summaryception_5.5.0.json](docs/preset/ff_summaryception_5.5.0.json)

## Slash commands

`/sc-status` shows the current summarized boundary and layer counts.

`/sc-preview` prints the memory block that would be injected.

`/sc-clear` clears Summaryception memory for the current chat and unghosts Summaryception-owned messages.

## Safety notes

Summaryception is designed to be non-destructive. Summaries live in chat metadata. Settings live in extension settings. Ghosting ownership is stored as stable message IDs in chat metadata, so the extension can tell its own hidden messages apart from messages you hid yourself.

If something looks off, use Clear or `/sc-clear`. That removes Summaryception's memory and ownership flags for the current chat, then unghosts the messages it owns.

## Presets

For default and prefix cache any preset works. I like this one https://rentry.org/freaky-frankenstein-presets

## Version history

Older major versions are still available as branches. Open SillyTavern's extension list and use the branch button beside Summaryception.

<img src="img/how_to_switch_branch.png" width="700" alt="Branch button beside Summaryception in SillyTavern's extension list" />

- **v24:** Continuity Auditor
- **v23:** Closed most github issues
- **v22:** Big code refactor

## Troubleshooting

Extension refuses to update: remove and install it again.

Major updates can reset settings or misbehave: clear memories before updating and stick to the named branches.

### Timestamps in bot replies

Make sure each bot message contain timestamps! Exact format is not important. Some gaps are allowed, as long as it repeated once every 4-5 bot messages. Example prompt:

```
{{// Grounds scene with date, time, location, weather. Affected entire RP.}}{{trim}}

<header_instructions>
Start every response with:
[ 🕰️ Time HH:MM AM/PM | 🗓️ Day # - 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area | [WeatherEmoji] Weather, Temp °F ]

Rules:
- Time: Advance logically; execute skips for sleep, work, or travel.
- Era: Use AD/BC or setting-appropriate fantasy era.
- Location: General - Specific area. Update on movement.
- NPCs: Physically react to weather, temp, and time (shiver, sweat, fatigue).
</header_instructions>
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
