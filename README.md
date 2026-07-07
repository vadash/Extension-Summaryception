# Summaryception

### Layered recursive memory for SillyTavern

Your AI remembers thousands of turns in under 20k tokens. No context bloat, no lost plot threads.

Summaryception is a memory system for [SillyTavern](https://github.com/SillyTavern/SillyTavern). Instead of brute-forcing the context window, it compresses older turns into compact summaries arranged in recursive layers. Your most recent conversation stays exactly as written; everything older gets progressively compressed.

---

## The problem

Every roleplayer hits the same wall:

| Approach | What happens |
|---|---|
| No summary | Context fills up, hard truncation kicks in, everything before the cutoff is gone forever. |
| Basic summarization | One lossy summary eats the details, so you compensate by keeping 20+ verbatim turns. Context still bloats. |
| More verbatim turns | 20 turns × 1,500 tokens = 30k tokens of atmospheric prose the LLM has to wade through. Attention degrades, costs rise, coherence drops anyway. |

The conventional wisdom — "just keep more raw turns" — is a band-aid for bad compression.

## The solution

Compress aggressively, lose nothing.

A summarizer prompt looks at each batch of turns against what's already been summarized, and outputs only the new stuff: plot points, state changes, character decisions. Nothing repeated.

Real example. Three turns, roughly 5,200 raw tokens, compressed to:

> Alina kisses Lodactio; he reciprocates; she grows to human size, straddling him; she squeezes his crotch and intends to undo his pants.

27 tokens. About 125:1 compression, with every plot-relevant beat intact.

---

## How it works (the "ception")

When Layer 0 fills with summaries, the oldest snippets get summarized again into Layer 1. When Layer 1 fills, they roll up into Layer 2. Each layer multiplies your memory capacity while keeping continuity.

```text
YOUR CHAT (e.g., 200 turns)
│
│  Turns 1-180: Ghosted (hidden from the AI, still readable by you)
│  Turns 181-200: Kept verbatim (recent chat)
│
│  The ghosted turns have been compressed into:
│
│  ┌──────────────────────────────────────────┐
│  │  LAYER 2 (Deep Memory)                   │
│  │  Ultra-compressed summaries of Layer 1   │
│  │  Each covers ~27 turns                   │
│  ├──────────────────────────────────────────┤
│  │  LAYER 1 (Meta-Summaries)                │
│  │  Compressed summaries of Layer 0         │
│  │  Each covers ~9 turns                    │
│  ├──────────────────────────────────────────┤
│  │  LAYER 0 (Turn Summaries)                │
│  │  Direct summaries of conversation turns  │
│  │  Each covers ~3 turns                    │
│  ├──────────────────────────────────────────┤
│  │  VERBATIM TURNS                          │
│  │  Sent word-for-word to the LLM           │
│  └──────────────────────────────────────────┘
```

The math works out to roughly 11,000 turns in 14k tokens. The raw conversation for that would be around 20 million tokens. Compression ratio approaching 1,000:1.

---

## Features

### Ghost mode (non-destructive)

Summaryception never deletes your messages. Summarized turns are "ghosted" — hidden from the AI's context window but still visible in your SillyTavern UI. Scroll up any time and the original prose is right there.

### Dual LLM routing (save money, get speed)

Use a fast, cheap, large-context model (local Llama-3 8B, GPT-4o-mini) for the frequent Layer 0 turn summaries. Reserve a smarter model (Claude 3.5 Sonnet, GPT-4o) for the rarer Layer 1+ promoted merges.

### Cache-friendly mode

If your API charges for context but offers prompt caching (Anthropic, DeepSeek), turn this on. It freezes your memory block and expands the live chat window, so the cached prefix gets reused across many turns. API costs drop noticeably.

### Clean prompt isolation

When Summaryception calls the summarizer, it temporarily disables your ST presets — character cards, scenarios, author's notes, the lot. The summarizer sees only its own prompt. Your preset is restored right after.

### The Slop Breaker

When the AI gets stuck repeating the same phrases or formatting, hit the Slop Breaker button. It forcefully summarizes the live context, wiping the short-term "slop" from the AI's attention while keeping the facts, so it has to generate fresh prose.

---

## Configuration

Instead of counting turns, Summaryception uses dynamic token budgets.

- **Verbatim token budget** — how much of the recent chat stays word-for-word. Keep this high enough (8k–16k) that the AI remembers the current scene's style and formatting.
- **Injected memory budget** — the maximum size of the Summaryception memory block. If it grows past this, deeper-layer promotions fire automatically to compress it back down.

### Prompt presets

- **Narrative State (default)** — best for character RP, drama, thrillers, romance. Focuses on interactions, emotions, relationships, atmosphere.
- **Game State** — best for RPGs, strategy, mechanical games. Focuses on plot points, quests, locations, inventory.
- **Custom** — write your own. You can define separate prompts for Layer 0 (turns) and Layer 1+ (deep memory).

---

## Installation

**Requirements:** SillyTavern 1.16.0+ (release or staging).

### From SillyTavern UI
1. Open **Extensions** (the block icon) → **Install Extension**
2. Paste `https://github.com/Lodactio/Extension-Summaryception`
3. Click Install
4. Find Summaryception in your Extensions settings.

### Manual install
```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/Lodactio/Extension-Summaryception
```
Restart SillyTavern and enable the extension.

---

## Version history

Switch branches in SillyTavern if you prefer an older version.

- **v13:** Tweaked few knobs. 10k memory can support 800 messages chat in L0 alone. Memory pyramid is now more balanced, 1 L4, 1 L3, 3 L2, 30 L1 wont happen.
- **v12:** Focus on stability. Tested on few RP till 2-3k messages. Main problem is STATE gets too big. Good stopping point but I have few ideas...
- **v11:** CN output filter (CN models love to add non EN symbols to output) and Dual-Track Architecture test.
Separate each summary into two tracks:
1. **Narrative track** -- free-form prose describing what happened (events, actions, dialogue outcomes)
2. **State track** -- a compact structured block of current durable facts (location, character states, relationships, inventory, unresolved hooks, counters)
On promotion, the state track is **merged by overwrite** (new values replace old), while the narrative track is **compressed by summarization**. This eliminates the root cause: the LLM no longer needs to guess which parts of prose are state vs events.
- **v10:** UI & prompt update. Redesigned the settings panel to be cleaner and more compact for ST sidebars. Added completely separate, customizable prompt editors for Layer 0 (recent turns) and Layer 1+ (deep memory merges).
Refactor debug logging. Add summarizer fallback connection.
- **v9:** The Elastic & Cache update.
  - *Dynamic Memory Budget:* you now set a total memory size (e.g., 10k tokens), and the extension balances Layer 0 and Layer 1+ to fit.
  - *Dual LLM Profile:* use one cheap API for daily summaries and a smart API for deep merges.
  - *Cache-Friendly Mode:* locks memory in place to take advantage of prompt caching on APIs like Anthropic.
- **v8:** Slop Breaker. Manual tool to forcefully summarize recent chat when the AI gets stuck in repetitive loops or formatting errors.
- **v7:** Consistent roleplay style. Replaced raw turn counts with the "Verbatim Token Budget" slider, so you control how much recent text the AI sees. Smoother UI when editing snippets.
- **v6:** The major modular rewrite. Speedups, background processing fixes, global regex support.

For memory testing I use RP with 3000 messages, then upload F12 to ai studio to analyze. L0 model is free gemma4, L1+ model is glm47, fallback glm52

---

## Community forks

These forks extend Summaryception with specialized features. Install only one at a time (existing settings and per-chat memory will carry over).

- [Per-Character Memory Banks](https://github.com/dogoo9/Extension-Summaryception) (dogoo9) — keeps separate summary memory for each character card in a group chat, preventing memory bleed.
- [Lorebook Ingestion](https://github.com/jeromehbonaparte-star/Extension-Summaryception-Lorebook) (Romuromylus) — extracts stable facts (traits, locations) from summaries and turns them into World Info / Lorebook entries.

---

Built out of frustration with context limits and love for long-form roleplay.
If this saves your 500-turn adventure from amnesia, consider starring the repo.

**License:** AGPL-3.0

## new UI (v11+)

<p align="center">
  <img src="https://github.com/user-attachments/assets/f1fda4c0-282e-4bbf-8924-98755fb461e0" width="180" alt="1" />
  <img src="https://github.com/user-attachments/assets/988a1227-7c43-4512-8256-67e8a98a8689" width="180" alt="2" />
  <img src="https://github.com/user-attachments/assets/515f7249-6b29-402f-9979-120e9cbfd336" width="180" alt="3" />
  <img src="https://github.com/user-attachments/assets/cd7a255c-4d52-4082-9e62-af6c40798a0a" width="180" alt="4" />
  <img src="https://github.com/user-attachments/assets/88f5de03-4414-4b7d-8b1a-3bfa60b5d3f8" width="180" alt="5" />
</p>
