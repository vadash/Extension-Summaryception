# 🧠 Summaryception

### Layered Recursive Memory for SillyTavern

> Your AI remembers **thousands of turns** in under **20k tokens**. No context bloat. No lost plot threads. No compromises.

Summaryception is a non-destructive, context-aware memory system for [SillyTavern](https://github.com/SillyTavern/SillyTavern). It replaces brute-force context stuffing with intelligent layered summarization. It keeps your most recent conversation exactly as written, while compressing older turns into ultra-compact summary snippets — organized in recursive layers that scale infinitely.

---

## ✨ The Problem

Every roleplayer hits the same wall:

| Approach | What happens |
|---|---|
| **No summary** | Context fills up → hard truncation → everything before the cutoff is **gone forever**. |
| **Basic summarization** | Lossy single summary → important details vanish → you compensate by keeping 20+ verbatim turns → context still bloats. |
| **More verbatim turns** | 20 turns × 1,500 tokens = 30k tokens of mostly atmospheric prose the LLM has to process → attention degrades, costs rise, and coherence drops anyway. |

The conventional wisdom — *"just keep more raw turns"* — is a band-aid for bad compression.

## 💡 The Solution

Summaryception flips the approach: **compress aggressively, lose nothing.**

A context-aware summarizer prompt examines each batch of turns against what's *already been summarized*, outputting only the **narrative delta** — new plot points, state changes, and character decisions. Nothing repeated, nothing lost.

**Real example** — 3 turns, ~5,200 raw tokens, compressed to:

> *Alina kisses Lodactio; he reciprocates; she grows to human size, straddling him; she squeezes his crotch and intends to undo his pants.*

**27 tokens. 125:1 compression. Every plot-relevant beat preserved.**

---

## 🔄 How It Works (The "Ception")

When Layer 0 fills up with summaries, the oldest snippets are grouped together and summarized *again* into **Layer 1**. When Layer 1 fills up, they are summarized into **Layer 2**. Each layer multiplies your memory capacity while maintaining narrative continuity.

```text
YOUR CHAT (e.g., 200 turns)
│
│  Turns 1-180: Ghosted (hidden from AI, still readable by you)
│  Turns 181-200: Kept VERBATIM (Recent chat)
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

> **The Math:** Summaryception can easily hold **~11,000 turns in ~14k tokens.** The raw conversation for that would be roughly 20 million tokens. That's a compression ratio approaching **1,000:1**.

---

## 🌟 Key Features

### 👻 Non-Destructive Ghost Mode
Summaryception **never deletes your messages**. Summarized turns are "ghosted" — hidden from the AI's context window but fully visible in your SillyTavern UI. Scroll up anytime to read the original prose.

### 🧠 Dual LLM Routing (Save Money & Speed)
Use a fast, cheap, large-context model (like a local Llama-3 8B or GPT-4o-mini) to do the frequent **Layer 0** turn summaries. Then, assign a highly intelligent model (like Claude 3.5 Sonnet or GPT-4o) to do the heavy-lifting **Layer 1+ Promoted Merges**. 

### ⚡ Cache-Friendly Mode
If you use APIs that charge for context but offer **Prompt Caching** (like Anthropic or DeepSeek), turn on Cache-Friendly mode. It freezes your Summaryception memory and expands your live chat window, allowing the API to reuse the cached prefix across many turns, dramatically lowering your API costs.

### 🧹 Clean Prompt Isolation
When Summaryception calls the summarizer, it **temporarily disables all your ST presets** — your creative writing prompts, character instructions, scenario text, etc. The summarizer sees *only* its own prompt. Your preset is restored instantly afterward.

### 🛑 The "Slop Breaker"
Is the AI stuck repeating the same phrases, formatting, or annoying habits? Hit the **Slop Breaker** button. It forcefully summarizes the immediate live context, wiping the AI's short-term memory of the "slop" while keeping the factual events, forcing it to generate fresh prose.

---

## ⚙️ Configuration & Budgets

Instead of manually counting turns, Summaryception uses **Dynamic Token Budgets** to balance your memory automatically.

- **Verbatim Token Budget:** How much of the *recent* chat stays word-for-word. Keep this high enough (e.g., 8k-16k) so the AI remembers the current scene's writing style and formatting.
- **Injected Memory Budget:** The maximum token size of your Summaryception memory block. If it gets too large, the system automatically triggers deeper layer promotions to compress it down.

### Prompt Presets
- **Narrative State (default):** Best for Character RP, drama, thrillers, romance. Focuses on interactions, emotions, relationships, and atmosphere.
- **Game State:** Best for RPGs, strategy, and mechanical games. Focuses on plot points, quests, locations, and inventory.
- **Custom:** Write your own! You can even define separate prompts for Layer 0 (turns) and Layer 1+ (deep memory).

---

## 📥 Installation

**Requirements:** SillyTavern 1.16.0+ (release or staging).

### From SillyTavern UI
1. Open **Extensions** (the block icon) → **Install Extension**
2. Paste: `https://github.com/Lodactio/Extension-Summaryception`
3. Click Install
4. Find **🧠 Summaryception** in your Extensions settings.

### Manual Install
```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/Lodactio/Extension-Summaryception
```
Restart SillyTavern and enable the extension.

---

## 📖 Version History

Switch branches in SillyTavern if you prefer an older version.

*   **v10:** **UI & Prompt Update.** Redesigned the settings panel to be cleaner and more compact for ST sidebars. Added completely separate, customizable prompt editors for Layer 0 (recent turns) and Layer 1+ (deep memory merges).
*   **v9:** **The Elastic & Cache Update.** 
    *   *Dynamic Memory Budget:* You now set a total memory size (e.g., 10k tokens), and the extension automatically balances Layer 0 and Layer 1+ to fit.
    *   *Dual LLM Profile:* Use one cheap API for daily summaries, and a smart API for deep memory merges.
    *   *Cache-Friendly Mode:* Drastically reduces costs on APIs like Anthropic by locking memory in place to take advantage of Prompt Caching.
*   **v8:** **Slop Breaker.** Added a manual tool to forcefully summarize recent chat when the AI gets stuck in repetitive loops or formatting errors.
*   **v7:** **Consistent Roleplay Style.** Replaced raw turn counts with the "Verbatim Token Budget" slider, giving you precise control over how much recent text the AI sees to maintain its writing style. Much smoother UI when editing snippets.
*   **v6:** The major modular rewrite. Massive speedups, background processing fixes, and global regex support.

---

## 🤝 Community Forks

These forks extend Summaryception with specialized features. Install **only one at a time** (your existing settings and per-chat memory will carry over).

- **[Per-Character Memory Banks](https://github.com/dogoo9/Extension-Summaryception) by dogoo9:** Keeps separate summary memory for each character card in a group chat. Prevents memory bleeding.
- **[Lorebook Ingestion](https://github.com/jeromehbonaparte-star/Extension-Summaryception-Lorebook) by Romuromylus:** Automatically extracts stable facts (traits, locations) from summaries and turns them into World Info / Lorebook entries.

---

Built with frustration at context limits and love for long-form roleplay.  
*If this saves your 500-turn adventure from amnesia, consider starring the repo. ⭐*

**License:** AGPL-3.0
