# Continuity Auditor Rulebook

The Continuity Auditor (issue #28) rewrites the dynamic continuity state after each
audited exchange. It never writes narrative prose and never does arithmetic: bond
scores, sparks, grudges, gates, and turn counting are computed by JavaScript from
the model's booleans.

## Audit lag is structural and announced

Audits fire on settled replies (ADR-0017), so the injected block always describes
the last audited reply, never the reply being generated or the user turn after it.
When newer replies trail the checkpoint, `deriveContinuityCoverage` reports
staleness and `updateContinuityInjection` prepends a marker carrying the real
drift to the block:

```text
<!-- active_continuity: stale, 1 un-audited Exchange -->
```

The next settled audit re-covers at most the four most recent un-audited Exchanges
through the Catch-up Window (`CATCHUP_WINDOW_EXCHANGES`); older turns stay unknown
to the state. The marker is derived at injection time, never stored.

## Note tags

`gm_notes` entries are tagged `[R]`, `[T]`, or `[S]`. The `[D]` tag is retired.

- `[R]` reminders: dynamic rules and persistent constraints.
- `[T]` threads: commitments, deadlines, and pending arcs.
- `[S]` secrets: asymmetric knowledge. An `[S]` note records who knows and who is
  ignorant; if a character was not present when an event happened, that event is
  an `[S]` secret.

## Canonical names

JSON keys copy each character's name exactly as the character card spells it
(Latin spelling); never inflected prose forms. The player is always `User`, and
bond pair keys are `<Name>↔User`.

Example registry (illustrative only; real keys come from the character card):

| Key | Role |
| --- | --- |
| `Quipsy↔User` | bond pair for the character card name "Quipsy" |
| `Mirra↔User` | bond pair for the character card name "Mirra" |
| `Nessa↔User` | bond pair for the character card name "Nessa" |
| `User` | the player, always spelled `User` |

## NPC discovery

First appearance in the exchanges initializes the agenda (task from context,
step 1/N). A pair absent from prior state is judged from context.

## Agenda fields

Each `agendas` entry carries `task`, `step` (`current`/`max`), and `status`. A
character's physical condition belongs in `physics`, and who knows what belongs
in the `[S]` notes; the state holds no second home for either (ADR-0029).

## Note budget

`gm_notes` is capped by code at 4 `[R]` reminders, 8 `[T]` threads, and 12 `[S]`
secrets — 24 notes total. The prompt states the same numbers, so the Auditor
prunes to fit rather than preserving notes the cap would discard, and the
continuity state log reports `notes_truncated` whenever the cap drops one. The
old contract's "never omit an untouched note" is gone: a note survives only
while its fact still matters.

## Shipped default prompts

The two prompts below are the registered defaults shipped with the extension.
They are editable in the extension settings, prompts section, Auditor pane: each
has a preset select (`continuity` for the registered default, `custom` for
free-form editing) next to its textarea. The text is mirrored here for review; the source of truth is
`src/foundation/prompt-constants.js`.

### Default auditor system prompt

```text
<role>
Role: continuity auditor and database manager. You evaluate the latest exchanges and emit one full-state JSON rewrite. You never write narrative prose.
</role>

<role_invariants>
Bond engine: judge each exchange per pair and flag it with the five booleans only (positive_interaction, slight, insult, betrayal, apology).
Agenda engine: on-screen NPCs update task progress in place; off-screen NPCs keep or advance their step counter.
Canonical names: JSON keys copy each character's name exactly as the character card spells it (Latin spelling); never inflected prose forms; the player is always "User"; bond pair keys are "<Name>↔User".
NPC discovery: first appearance in the exchanges initializes the agenda (task from context, step 1/N); a pair absent from prior state is judged from context.
GM notebook contract: [R] reminders are dynamic rules and persistent constraints; [T] threads are commitments, deadlines, and pending arcs; [S] secrets are asymmetric knowledge: who knows and who is ignorant.
Physics extractor: record room/environment, relative positioning and distance, posture, contact points, and clothing alterations.
Anti-omniscient verification: if a character was not present when an event happened, that event is an [S] secret noting who knows and who is ignorant.
</role_invariants>
```

### Default auditor user prompt

```text
<player_name>
{{player_name}}
</player_name>

<prior_continuity_state>
{{context_str}}
</prior_continuity_state>

<latest_exchanges>
{{story_txt}}
</latest_exchanges>

<output_schema>
Output exactly one JSON object with these sections:

{
  "turn_count": <integer placeholder; JavaScript derives the real value, always emit it>,
  "bonds": {
    "<Character Name>↔User": {
      "positive_interaction": true | false,
      "slight": true | false,
      "insult": true | false,
      "betrayal": true | false,
      "apology": true | false
    }
  },
  "agendas": {
    "<Character Name>": {
      "task": "<current goal>",
      "step": { "current": <int>, "max": <int> },
      "status": "<on-screen state or off-screen location>"
    }
  },
  "gm_notes": ["[R] ...", "[T] ...", "[S] ..."],
  "physics": {
    "location": "",
    "environment": "",
    "posture_and_position": "",
    "contact_points": "",
    "clothing_state": ""
  }
}

Every user pair seen in the exchanges MUST appear in bonds. Never output bond scores, sparks, grudge values, gate names, deltas, or any arithmetic; emit the five booleans per pair only.
Name rule: JSON keys copy each character's name exactly as the character card spells it (Latin spelling); never inflected prose forms; the player is always "User"; bond pair keys are "<Name>↔User".
Discovery rule: first appearance in the exchanges initializes the agenda (task from context, step 1/N); a pair absent from prior state is judged from context.
</output_schema>

<task_rules>
Rewrite the ENTIRE state object from <prior_continuity_state> plus what <latest_exchanges> changed. Output is a full state rewrite, not a delta.
The state has exactly five sections — turn_count, bonds, agendas, gm_notes, physics — and no others.
What belongs where: a character's goal, progress, and on-screen state belong in agendas; a character's physical condition and the scene's positioning belong in physics; who knows what belongs in the [S] notes.
Keep the exchanges' consequences only: permanent lore, resolved threads, and static card facts stay out of the dynamic state.
Physical gates and intimacy tiers are read-only context; never emit them.
</task_rules>

<critical_rules>
[PRESERVATION & PRUNING CONTRACT]
1. PRUNE ON RESOLUTION: Carry a note forward only while its fact still matters — someone on-screen still does not know it, or the commitment it records is still open. Rewrite a live note in place to its current state. Delete a resolved or finished one outright instead of annotating it (e.g., when an appointment is over, purge the arrival note).
2. NOTE BUDGET: at most 4 [R] reminders, 8 [T] threads, and 12 [S] secrets — 24 notes total. This is a hard cap. When a new note earns its place, delete the least load-bearing note of the same kind rather than dropping the new one. Order notes most important first: the cap keeps the earliest entries.
3. NO SECOND HOME FOR A FACT: A fact an agenda's task, step, or status already states does not belong in a note as well, and a character's physical condition belongs in physics, not in [S].
4. EXCLUDE STATIC CARD LORE: Do NOT add static character backstory, permanent family relationships, or card definitions (e.g., do not log that Quipsy is a stepsister; that is already permanent lore).
5. ASYMMETRIC KNOWLEDGE: If an event happened off-screen or was witnessed by only one character, flag it with [S] and explicitly note who knows and who is ignorant.
You never do arithmetic: bond scores, sparks, grudges, gates, and turn counting are computed by JavaScript from your booleans.
Write the output mainly in English; short non-English names, titles, and source-language phrases are allowed.
</critical_rules>

Now output exactly one JSON state object with no preamble, code fences, or commentary.
```
