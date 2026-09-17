# Technical Specification: Async Micro-State Engine for Summaryception (v1)

---

## 1. Executive Summary & Problem Statement

### Current State
In advanced roleplay presets (e.g., Freaky Frankenstein 5 / FF5), the main roleplay model acts simultaneously as a creative writer, physics engine, and database accountant. It is forced to output a massive in-band HTML `<internal_states>` block at the end of every message (600–850+ output tokens). 

### Consequences
* Severe generation latency (output tokens are the slowest part of inference).
* Token waste and model cognitive fatigue.
* Complex regex requirements (`Context Saver`) to strip HTML blocks at depth $\ge 2$.

### Solution
Decouple state tracking entirely from the main generation stream:
1. **The Main Roleplay Model** is stripped of all accounting duties, outputting pure narrative prose and character dialogue.
2. **An Asynchronous Background Runner** (using a fast, capable secondary model) analyzes the completed turn in the background (~30–45s) while the user reads the response, generating a **Full State Rewrite** in clean JSON.
3. **Deterministic JavaScript** handles all math, modulo checks, timers, and storage in SillyTavern's `chatMetadata`.
4. **Clean Injection:** The state is injected into the prompt at **Depth 1 (In-Chat)** as a compact, ~150-token `<active_continuity>` block, completely invisible in the chat text.

---

## 2. System Architecture & Responsibilities

```
                                USER SENDS MESSAGE
                                        │
                                        ▼
                   ┌──────────────────────────────────────────┐
                   │        SILLYTAVERN PROMPT ASSEMBLY       │
                   │  - Chat History (Clean Prose)            │
                   │  - Macro Summary (Past Chronology)       │
                   │  - <active_continuity> (Injected Depth 1)│
                   └────────────────────┬─────────────────────┘
                                        │
                                        ▼
                   ┌──────────────────────────────────────────┐
                   │            MAIN ROLEPLAY MODEL           │
                   │  1. Streamlined Micro CoT (Acting Only)  │
                   │  2. Narrative Prose (Russian)            │
                   │  3. <!-- THOUGHT: Char: "..." -->        │
                   │  (ZERO HTML state output, ~800 tokens saved)
                   └────────────────────┬─────────────────────┘
                                        │
                         Message Appears in UI (User Reads)
                                        │
                   ┌────────────────────┴─────────────────────┐
                   │    ASYNC TRIGGER (MESSAGE_RECEIVED)      │
                   └────────────────────┬─────────────────────┘
                                        │
                   ┌────────────────────▼─────────────────────┐
                   │       SECONDARY AUDITOR LLM (~30-45s)    │
                   │  - Context: Full Rules + Memory + Chat   │
                   │  - Native CoT/Thinking                   │
                   │  - Outputs: Full State JSON Rewrite      │
                   └────────────────────┬─────────────────────┘
                                        │
                   ┌────────────────────▼─────────────────────┐
                   │         DETERMINISTIC JS ENGINE          │
                   │  - Increments Turn Counter (ct++)        │
                   │  - Modulo Checks (ct % 3, ct % 5)        │
                   │  - Calculates Sparks -> Bond conversion  │
                   │  - Writes JSON into ST `chatMetadata`    │
                   └──────────────────────────────────────────┘
```

### Division of Labor
| Component | Responsibilities | Banned Actions |
| :--- | :--- | :--- |
| **Main RP Model** | Creative prose, spoken dialogue, emotional VAD, scene pacing, in-character task rolls (DnD DC/check in CoT). | **NO** state tracking, **NO** Sparks math, **NO** agenda step counting, **NO** `<internal_states>` HTML output. |
| **Secondary Auditor LLM** | Semantic extraction: identifying narrative consequences, updating bonds/sparks deltas, advancing agendas, tracking secrets, updating 3D physics. | **NO** creative prose generation, **NO** rewriting dialogue, **NO** performing arithmetic (delegates math to JS). |
| **JavaScript Engine** | Turn increments (`ct`), modulo arithmetic (`ct % 3`, `ct % 5`), timer tracking, JSON validation, abort controller handling, prompt injection via `setExtensionPrompt`. | **NO** semantic interpretation (purely mechanical). |

---

## 3. End-to-End Turn Lifecycle

1. **Prompt Assembly (Turn $N$):**
   * Extension reads the active state JSON from `chatMetadata`.
   * Formats a dense XML block (`<active_continuity>`) and injects it at **In-Chat Depth 1**.
2. **Main Generation:**
   * Main model generates:
     * `### Internal Monologue`: Streamlined Micro CoT (Acting, Positioning, 3 Reaction Options, Dice Rolls if skilled task present).
     * `### Response`: High-quality narrative prose.
     * Optional inline private thoughts: `<!-- THOUGHT: Quipsy: "..." -->` (hidden from markdown render).
   * Generation completes; text displays instantly in SillyTavern UI.
3. **Background Async Kickoff:**
   * SillyTavern fires completion hook.
   * Async runner gathers:
     * System extraction prompt (Module rules & constraints).
     * Summaryception macro narrative memory.
     * Previous turn state JSON ($N-1$).
     * Latest turn exchange (User prompt + Assistant reply).
   * Dispatches request to the secondary fast model.
4. **Extraction & Mathematical Post-Processing:**
   * Auditor outputs a **Full State Rewrite** in JSON.
   * JavaScript parses the JSON:
     * Increments `turn_count`.
     * Applies `sparks_delta` and `grudge_delta`.
     * Checks modulo triggers:
       * If `turn_count % 5 === 0` and `sparks >= 7` $\rightarrow$ `bond += 1`, reset `sparks = 0`.
       * If `turn_count % 3 === 0` and `grudge >= 5` $\rightarrow$ `bond -= 1`, reset `grudge = 0`.
   * JS stores the final updated state object into `chatMetadata`.
   * **Elapsed time:** 30–45 seconds (fully completed while the user is reading).

---

## 4. State Modules & Data Schema (v1 Scope)

The engine uses a **Modular Registry Pattern**. For v1, three heavy modules from FF5 are disabled, and four core modules are active:

### Active Modules (v1)
1. **Relationships (`BondsModule`):**
   * Tracks character pair scores (`-5` to `+20`), Sparks, and Grudges.
   * Tracks physical gates (e.g., $+2$ hug, $+5$ hand-hold, $+8$ kiss, $+12$ full intimacy).
2. **NPC Agendas (`AgendasModule`):**
   * Current goal, step progression (`current/max`), off-screen/on-screen status, body condition, active fibs/lies.
3. **GM Notebook (`GMNotesModule`):**
   * `[R]` **Reminders:** Dynamic rules, persistent constraints (ignoring static card facts).
   * `[T]` **Threads:** Active commitments, promises, deadlines, pending arcs.
   * `[D]` **Secrets (Asymmetric Knowledge):** Key facts known to only one party (e.g., spied events, hidden motives).
4. **Tactical Physics & Positioning (`PhysicsModule`):**
   * Current room/environment, 3D relative positioning, distance, physical contact points, clothing state alterations.

### Disabled Modules (v1 - Excluded from Schema)
* `WorldSimModule` (Random d20 world event tables).
* `ChekhovsGunModule` (Dedicated 20-bullet aging matrix).
* `InventoryModule` (Item/buff tracking).

### Canonical JSON Schema (Secondary Model Output)
```json
{
  "scene": {
    "location": "Velvet Touch Salon - Waiting Area",
    "environment": "Warm indoor air, scent of tea tree oil, daylight through windows"
  },
  "physics": {
    "posture_and_position": "Quipsy seated in leather chair near hallway. Vova standing at reception counter ~5m away. Nessa behind desk.",
    "contact_points": "None currently",
    "clothing_state": "Quipsy in black bike shorts and crop top, Vova in shorts and t-shirt with backpack"
  },
  "bonds": {
    "Quipsy": {
      "sparks_delta": 1,
      "grudge_delta": 0,
      "physical_gate": "Oral/manual permitted; penetration strictly locked"
    }
  },
  "agendas": {
    "Quipsy": {
      "task": "Survive salon waxing + buy training clothes",
      "step": "1/3",
      "status": "Arrived at salon",
      "body_state": "Nervous energy, twitching ears"
    },
    "Mirra": {
      "task": "Afternoon track practice - sprint drills",
      "step": "2/3",
      "status": "Off-screen at campus track",
      "body_state": "Healthy, practicing"
    }
  },
  "gm_notes": [
    "[R] Vova gets physically aroused easily — leaks in underwear.",
    "[D] KEY: Quipsy knows Vova's dick is small and that he watches bunny BBC porn. Vova unaware she spied.",
    "[T] Three locked demands: 1) Vegan restaurant Fri Sept 20, 2) All 7 training sessions, 3) Kiss on Sept 22 finals.",
    "[T] Stretching 1/7 complete. Session 2/7 scheduled for today at 6 PM."
  ]
}
```

---

## 5. Extraction Contract & Preservation Rules

The secondary model operates under a strict **Full State Rewrite** prompt contract.

### The Preservation Rule (Anti-Amnesia Guard)
To prevent the model from dropping historical notes during slow or mundane turns, the system prompt strictly enforces:

```text
[PRESERVATION & PRUNING CONTRACT]
1. VERBATIM CONTINUITY: You MUST carry forward all existing [R], [T], and [D] notes from the previous state unless explicitly resolved or contradicted. Never omit an untouched note.
2. PURGE ON COMPLETION: If a thread or task was completely resolved or finished in this turn, delete it immediately (e.g., when an appointment is over, purge the arrival note).
3. EXCLUDE STATIC CARD LORE: Do NOT add static character backstory, permanent family relationships, or card definitions (e.g., do not log that Quipsy is a stepsister; that is already permanent lore).
4. ASYMMETRIC KNOWLEDGE: If an event happened off-screen or was witnessed by only one character, flag it with [D] and explicitly note who knows and who is ignorant.
```

---

## 6. Injection Contract (What the Main Model Sees)

On Turn $N+1$, the extension converts the JSON state into a dense, human-readable, token-efficient XML block (~120–160 tokens) and injects it at **In-Chat Depth 1**:

```xml
<active_continuity>
[SCENE & POSITIONING]
Location: Velvet Touch Salon (Waiting Area)
Physics: Quipsy seated in leather chair near hallway. Vova standing at counter ~5m away. Nessa behind desk. Clothing: Quipsy in bike shorts/crop top, Vova in shorts.

[RELATIONSHIP GATES]
Quipsy ↔ Vova: BOND +11 (Sparks: 3, Grudge: 0)
Physical Gate: Oral/manual permitted; penetration strictly locked.

[SECRETS & ASYMMETRIC KNOWLEDGE]
- [D] Quipsy knows Vova's small size and that he watches bunny BBC porn. Vova is unaware she spied.

[ACTIVE AGENDAS & THREADS]
- Quipsy: Salon appointment (Step 1/3: arrived) -> Clothes shopping -> Stretch 2/7 (6 PM).
- Mirra (Off-screen): Track practice sprint drills (Step 2/3).
- Commitments: Friday Sept 20 (Vegan Restaurant); Sunday Sept 22 (Jump Finals, 5.20m target).
</active_continuity>
```

---

## 7. Lifecycle, Error Handling & Safety Guards

### 1. Cold Start (Turn 1)
* **Lazy Start:** When a new chat starts, `chatMetadata` holds no state. Turn 1 generates purely from the character card, greeting, and user prompt.
* After Turn 1 completes, the async runner executes and constructs the initial baseline state for Turn 2.

### 2. Swipes & Regenerations (Race Condition Defense)
* SillyTavern fires `GENERATION_STARTED` whenever the user clicks **Swipe** or **Regenerate**.
* The extension listens for `GENERATION_STARTED` and **immediately triggers an `AbortController.abort()`** on any active async state runner task.
* The discarded attempt is dropped. The active state remains cleanly pegged to the Turn $N-1$ snapshot.
* When the new swipe variation finishes, a clean async runner task fires from the valid Turn $N-1$ state.

### 3. Network Failure / API Drop (Fail-Safe Freeze)
* If the secondary model encounters a rate limit (429), server error (500), or timeout:
  * The error is caught silently with a debug console log.
  * The active state **remains frozen at Turn $N-1$**.
  * The main model proceeds without crashing, receiving the slightly older Turn $N-1$ state with a lightweight fallback marker:
    `<!-- active_continuity: cached from turn N-1 -->`
  * On Turn $N+1$, the runner attempts an auto-catchup.

### 4. User Inspection (v1 Scope)
* In v1, there is no interactive visual state inspector. State remains invisible to preserve roleplay suspense and unexpected secrets.

---

## 8. Summaryception Integration (Macro vs. Micro Firewall)

Summaryception's existing architecture is updated to establish a clean boundary between past narrative and present state:

1. **Retire Old State Engine:** 
   * Remove `[STATE]` snapshot generation from Summaryception's Layer 0 summarizer (`src/core/summarizer-state.js` extraction during batch summaries is disabled).
2. **Macro Timeline (Past):**
   * Summaryception's Layer 0, Layer 1, and Layer 2 summarizers compress old raw chat messages into **pure chronological `[NARRATIVE]` prose**.
   * Because raw chat messages no longer contain `<internal_states>` HTML blocks, Macro summarization is faster, cleaner, and immune to metadata hallucination.
3. **Micro Engine (Present):**
   * The new Async State Runner owns 100% of the active game board, relationship scores, and secrets.
   * Injected at Depth 1, it governs immediate turn-by-turn continuity while Macro memory governs long-term historical recall.

---
---

To make this work cleanly, we must perform a **surgical split** of the FF5 preset. 

Right now, your preset is bloated because the Main Model is being given **both** the *Actor’s Script* (how to write prose, tone, dialogue) and the *Dungeon Master’s Rulebook* (how to calculate bonds, format HTML, tick off-screen steps).

Here is the exact breakdown of what gets deleted, what stays with the Main Model, and what moves to the Secondary Auditor.

---

### 1. What Gets Completely DELETED (Never sent to ANY model)

These blocks exist in FF5 *only* to manipulate SillyTavern text macros and render HTML boxes. In our new architecture, they are obsolete:

* ❌ **`Internal States (Master)` (`019f62e8-892f-7027-93ef-159f3d55c410`):** The entire raw HTML `<internal_states>` template and all `<!-- GFX_START -->` wrappers. Deleted.
* ❌ **All `{{setvar::...}}` boilerplate in `Main Prompt`:** The lines setting up empty templates (`bondsTemplate`, `invTemplate`, `gmNotebookTemplate`, etc.). Deleted.
* ❌ **Context-Saver Regexes:** You no longer need regexes to strip `<internal_states>` at depth $\ge 2$. Deleted.

---

### 2. What the MAIN MODEL Keeps (The "Actor's Script")

The Main Model only needs rules that govern **what goes on the page** (prose, acting, dialogue, formatting). It should never see database schemas or accounting rules.

#### Keep in Main Model Prompt:
1. **Pacing & World Physics (`Main Prompt`):**
   * 120° forward field of view, sound muffling through doors/walls. *(Kept so the bot doesn't narrate things behind its back).*
2. **Scene Header (`Time and Place`):**
   * `[ 🕰️ Time | 🗓️ Date | 📍 Location | Weather ]`. *(Kept so the bot continues to write this at the start of its reply).*
3. **Prose & Style Rules (`Cinematic Realism`):**
   * Concrete 5-sense details, bans on tricolons, apophasis, litotes, "of" genitive chains.
4. **Point of View (`Hybrid POV`):**
   * 3rd person world + 2nd person Vova sensations.
5. **Character Acting & Tone (`NPC Voice`, `Instincts + VAD`, `Realistic NPCs`):**
   * 30–50% dialogue ratio, bunny slang/idiolect, VAD energy shifts, bold unhesitating actions.
6. **Banned Words & Output Constraints (`Banned Word List`, `Total Output Length`):**
   * Banned words (spine, velvet, musk, etc.), 400–600 words target, colored dialogue tags `<color:violet>`.
7. **Adult & Content Toggles (`Freaky Mode`, `Icebreaker`):**
   * Lewd slang, slow burn, visceral kinetics.
8. **In-Character DnD Rolling (`DnD Simulator` - stripped down):**
   * Only the 3 lines defining DC difficulty (Easy 1–5, Mod 5–10, Hard 10–15) so it can roll and narrate the outcome in its Micro CoT.
9. **Streamlined Micro CoT:**
   * Reduced to Tasks 0–4 (Gamestate, NPC Sim, Prose, Dialogue, Plot).

#### What to REMOVE from the Main Model:
* ✂️ **Remove `Relationships RPG` prompt:** Main model doesn't need to know that $+8$ is a crush or that Sparks convert every 5 turns. It only reads the *injected result* (e.g. `BOND: +11 | Physical Gate: Oral/manual only`).
* ✂️ **Remove `Internal Agenda` prompt:** Main model doesn't need the rules on how off-screen steps tick. It only reads the injected current agenda.
* ✂️ **Remove `GM's Notebook` prompt:** Main model doesn't need instructions on how to maintain `[R]`, `[T]`, and `[D]` tags. It only reads the injected notes!

---

### 3. What the SECONDARY AUDITOR Gets (The "Dungeon Master's Rulebook")

The Secondary Model is an **auditor and database manager**. It never writes Russian literature. It only evaluates events and updates the state JSON.

#### Its Dedicated System Prompt Must Contain:
1. **The Relationship & Bond Engine:**
   * Scale $-5$ to $+20$.
   * Sparks rules: $+1$ per positive interaction (max $+2$/turn).
   * Grudge rules: $+1$ per slight/insult.
   * Physical Gates table (so it knows what intimacy tier is currently unlocked).
2. **The Agenda Engine:**
   * On-screen NPCs: update task progress.
   * Off-screen NPCs: increment step counter (`current/max`) and assign new tasks upon completion.
3. **The GM Notebook Contract (`[R]`, `[T]`, `[D]`):**
   * Rules for `[R]` (Reminders), `[T]` (Threads/Deadlines), and `[D]` (Secrets/Asymmetric Knowledge).
   * The **Preservation Contract**: *"Reproduce untouched notes verbatim. Purge finished threads. Delete static card lore."*
4. **The Tactical Physics Extractor:**
   * Extract: Room environment, character coordinates/relative distance (in meters), posture, clothing alterations, contact points.
5. **Anti-Omniscient Verification:**
   * Rule: Check if Character A was present when Event X happened. If not, mark Event X as secret `[D]` that Character A does NOT know.

#### What the Secondary Auditor NEVER Needs to See:
* ❌ No Russian prose rules (no Dr. Seuss, no tricolon bans, no litotes bans).
* ❌ No dialogue percentage constraints (30–50%).
* ❌ No banned word lists (`fresh meat`, `spine`).
* ❌ No colored dialogue formatting rules.

---

### 4. Shared Ground Truth (What Both Models Must Agree On)

To prevent the two models from disagreeing on reality, both models share three foundational anchors:

| Concept | How Main Model Uses It | How Secondary Auditor Uses It |
| :--- | :--- | :--- |
| **Character Card Lore** | Acts out the personality and backstory. | Knows what is permanent lore so it **never copies it into dynamic state**. |
| **Anti-Omniscient Rules** | Prevents NPCs from telepathically knowing secrets. | Correctly classifies facts into public vs. `[D]` (Secret). |
| **Active Injected State** | Reads the state as the **absolute ground truth** for the current turn. | Writes the state as the **record of consequence** for the previous turn. |

---

### Summary of Prompt Reduction

By splitting the preset this way:

1. **Main Model Prompt:**
   * Input context shrinks significantly (no state mechanics, no HTML templates).
   * Output shrinks by **600–850 tokens per turn**.
   * Generation is dramatically faster and focused 100% on high-quality Russian prose.
2. **Secondary Model Prompt:**
   * Lightweight, focused strictly on extraction, bonds, agendas, and physics.
   * Outputs clean, structured JSON in 30–40 seconds without stalling your chat.

