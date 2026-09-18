import {
    buildSystemPrompt,
    buildUserPrompt,
    EXECUTION_TRIGGER_AUDITOR,
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
} from './prompt-parts.js';

/**
 * Full State Rewrite preservation contract, verbatim from the Continuity
 * Engine spec (§5, Extraction Contract & Preservation Rules).
 */
const AUDITOR_PRESERVATION_RULES = `[PRESERVATION & PRUNING CONTRACT]
1. VERBATIM CONTINUITY: You MUST carry forward all existing [R], [T], and [S] notes from the previous state unless explicitly resolved or contradicted. Never omit an untouched note.
2. PURGE ON COMPLETION: If a thread or task was completely resolved or finished in this turn, delete it immediately (e.g., when an appointment is over, purge the arrival note).
3. EXCLUDE STATIC CARD LORE: Do NOT add static character backstory, permanent family relationships, or card definitions (e.g., do not log that Quipsy is a stepsister; that is already permanent lore).
4. ASYMMETRIC KNOWLEDGE: If an event happened off-screen or was witnessed by only one character, flag it with [S] and explicitly note who knows and who is ignorant.`;

const AUDITOR_NAME_RULE =
    'JSON keys copy each character\'s name exactly as the character card spells it (Latin spelling); never inflected prose forms; the player is always "User"; bond pair keys are "<Name>↔User".';

const AUDITOR_DISCOVERY_RULE =
    'first appearance in the exchanges initializes the agenda (task from context, step 1/N); a pair absent from prior state is judged from context.';

export const ENGLISH_FIRST_LANGUAGE_RULE =
    'Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.';

export const ANTI_RUN_ON_RULE =
    'Write in short, direct sentences. Prefer periods over commas and semicolons; do not chain actions together with commas, semicolons, or conjunctions into run-on sentences. Limit each sentence to roughly two actions or events.';

/**
 * Shared salience quartet for "core moments" across L0 and promotion slots;
 * single source so the short mentions cannot drift apart.
 */
const CORE_MOMENT_TYPES = 'firsts, shifts, breaks, and unpaid choices';

export const LAYER0_DURABILITY_RULES =
    'Preserve each major durable beat once; shrink its wording, but never delete a beat the present situation depends on. ' +
    'Keep a moment when it is a first (first vulnerability, first touch, first broken rule), a shift (trust, power, attraction, or perception that changes and stays changed), a break (a mask drops or distance collapses), or a choice whose debt is still unpaid; dropping it would make a current emotion or relationship state incomprehensible. ' +
    'The older the material, the harder the cut. Collapse repeated actions, physical interaction, or dialogue loops into one outcome sentence. ' +
    'Omit brands, shopping routes, meals, clothing, poses, body mechanics, ordinary props, small talk, and temporary physical conditions unless they create a lasting decision, rule, resource, injury, or unresolved hook. ' +
    'Keep the cause-to-effect chain intact: never drop the link that explains how the present situation came to be.';

export const PROMOTION_MODERATE_MACRO_RULES =
    'Keep named people and places only when needed to understand a lasting relationship, obligation, location, or unresolved hook. Drop ages, brands, shopping routes, meals, clothing, one-off supplies, and mechanical scene replay; keep dialogue only when it is the reveal or the choice. Prefer cumulative outcomes over a list of scene beats; deeper folds cut harder.';

/**
 * Prose date format rule, shared across Layer 0 and Layer 1+ prompts.
 * The current year is already carried in the snippet's current_date_time metadata,
 * so repeating it in prose wastes tokens and creates opener-style drift.
 * ISO dates and clock times are data-channel formats reserved for current_date_time only.
 * Story-relevant clock time (alarm, deadline, shift boundary) may still appear once
 * mid-sentence in the narrative body, never as a date lead-in.
 */
export const PROSE_DATE_FORMAT_RULE =
    'In [NARRATIVE] prose, write dates in calendar form only: month name and day number, no year, no ISO syntax, no clock time. ' +
    'Write "On July 6" not "On July 6, 2024", not "On 2024-07-06", not "On July 6 at 19:00". ' +
    'The current year and exact hour live only in current_date_time; never duplicate them into prose. ' +
    'A clock time may appear once mid-sentence when it carries story weight (an alarm, a deadline, a shift boundary); never use it as a date lead-in.';

export const DEFAULT_INJECTION_TEMPLATE =
    '<summaryception_memory>\n' +
    'Compressed continuity. Newer verbatim chat and the current user message take priority.\n' +
    "[CHRONOLOGY] = past events, oldest to newest. [X-Y@YYYY-MM-DDTHH] = source messages X-Y; scene time at Y also serves as that passage's reference date; resolve any relative time words (tomorrow, today, in N days, next/bare weekday, this evening) in the adjacent narrative against it.\n" +
    '{{summary}}\n' +
    '</summaryception_memory>';

/**
 * Sample wrapper that repeats the memory block for stronger recall. Models
 * attend most to the start and end of the prompt, so a second copy near the
 * end reinforces past events. Built from the default so both stay in sync.
 */
export const RECALL_REPEAT_INJECTION_TEMPLATE =
    DEFAULT_INJECTION_TEMPLATE + '\n\n---REPEATED FOR RECALL---\n\n' + DEFAULT_INJECTION_TEMPLATE;

export const DEFAULT_SUMMARIZER_SYSTEM_PROMPT = buildSystemPrompt(
    'Role: editorial narrative compressor. Distill the passage into one [NARRATIVE] paragraph, keeping ' +
        CORE_MOMENT_TYPES +
        ' while cutting excess tissue.',
    'No preamble, no commentary, no markdown code fences.\nNever use second-person pronouns in the output.\nWrite the output mainly in English; short non-English names, titles, and source-language phrases are allowed.',
);

const LAYER0_INPUT_BLOCKS = `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>`;

const LAYER0_SCHEMA_BLOCK = `Output exactly one section, followed by a current_date_time line:

[NARRATIVE]
<one dense chronological prose paragraph covering the passage's events, actions, dialogue, outcomes, and its core emotional moments (${CORE_MOMENT_TYPES}). Do NOT include factual parameters like dates, inventory lists, or status flags here. ${ANTI_RUN_ON_RULE}>
Resolve any relative time reference in the passage (tomorrow, today, in N days, next/bare weekday, this evening) against the known scene date and write the RESOLVED ABSOLUTE DATE inline in the prose instead of the relative word. Never leave a bare relative time word in the narrative.
${PROSE_DATE_FORMAT_RULE}
${LAYER0_DURABILITY_RULES}

current_date_time: YYYY-MM-DD HH ddd
Use 24-hour, hour-level precision only, e.g. 2024-07-04 16 Thu. Derive the ddd weekday from the ISO date (2024-07-04 = Thu); never reuse the prior scene time when the passage moves to a new date. Normalize from raw bracket headers or passage timestamps when present. Drop minutes instead of preserving them. If no explicit time appears in the passage, carry forward the prior current_date_time if known.`;

const LAYER0_CRITICAL_RULES = `${ENGLISH_FIRST_LANGUAGE_RULE}
${LAYER0_DURABILITY_RULES}
${PROSE_DATE_FORMAT_RULE}
${ANTI_RUN_ON_RULE}`;

const PROMOTION_INPUT_BLOCKS = `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<narratives_to_consolidate>
{{story_txt}}
</narratives_to_consolidate>`;

const PROMOTION_CRITICAL_RULES = `${ENGLISH_FIRST_LANGUAGE_RULE}
${PROSE_DATE_FORMAT_RULE}
${ANTI_RUN_ON_RULE}`;

export const DEFAULT_SUMMARIZER_USER_PROMPT = buildUserPrompt({
    inputBlocks: LAYER0_INPUT_BLOCKS,
    schemaBlock: LAYER0_SCHEMA_BLOCK,
    taskRules: `Compress only the essential narrative progression from <passage_in_question> using <prior_context> as the baseline.
Read the entire provided passage before writing; never summarize only its tail.
Treat <prior_context> as settled history: never restate it; add only what the passage changed: stakes, goals, feelings, trust, attraction, power, obligations, knowledge, resources, threats, or direction. If the passage repeats a prior pattern without escalation, record it in one clause or not at all.
A relationship or emotional change must have its causing moment shown in the narrative.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
Keep the narrative compact; follow the sentence cap provided at the end of this prompt.
Durable changes belong in the narrative; ephemeral trivia does not. Do NOT preserve clothing, pose, momentary mood/arousal, ordinary props, completed errands, resolved hooks, physiological or sex counters, consumed food/drink, or soiled/used/disposed temporary items.
End with the current_date_time line described in the output schema.`,
    criticalRules: LAYER0_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_L0,
});

export const DEFAULT_SUMMARIZER_REPAIR_PROMPT = buildUserPrompt({
    inputBlocks: LAYER0_INPUT_BLOCKS,
    schemaBlock: LAYER0_SCHEMA_BLOCK,
    taskRules: `The previous Layer 0 summary attempt failed output validation. Repair the response by summarizing the same passage again with stricter formatting.
Apply the durability rules strictly: keep ${CORE_MOMENT_TYPES} with their cause-to-effect chain; cut excess tissue harder than the first attempt; read the entire provided passage.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
Omission removes a fact rather than preserving it. Exclude transient scene detail, completed tasks, resolved hooks, and ordinary items.
Keep the narrative compact; follow the sentence cap provided at the end of this prompt.
Always include current_date_time using YYYY-MM-DD HH ddd, carrying forward the prior value if no explicit time appears.
Do not include prose, bullets, tables, duplicate section headers, markdown, or commentary after the current_date_time line.`,
    criticalRules: LAYER0_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_L0,
});

export const DEFAULT_PROMOTION_SYSTEM_PROMPT = buildSystemPrompt(
    'Role: editorial memory synthesizer. Fold older layers into one consolidated [NARRATIVE] paragraph that keeps the plot skeleton and core emotional moments while cutting excess tissue.',
    'No preamble, no commentary, no markdown.\nNever use second-person pronouns in the output.\nWrite the output mainly in English; short non-English names, titles, and source-language phrases are allowed.',
);

export const DEFAULT_PROMOTION_USER_PROMPT = buildUserPrompt({
    inputBlocks: PROMOTION_INPUT_BLOCKS,
    schemaBlock: `Output exactly one section:

[NARRATIVE]
One single prose paragraph containing AT MOST {{max_sentences_word}} ({{max_sentences}}) sentences total. Summarize major plot outcomes only.
<one dense third-person chronological prose paragraph. Never use second-person. ${ANTI_RUN_ON_RULE}>`,
    taskRules: `### LENGTH CONTRACT (HARD LIMIT):
The consolidated [NARRATIVE] must stay within the sentence cap given at the end of this prompt. This is a hard limit: if a draft runs long, delete whole beats rather than trimming wording. Overlong output is rejected and regenerated.
### LOSSY COMPRESSION:
The input memories overlap heavily: each was written with the prior ones as context, so they restate the same relationships, rules, locations, and props. Treat that overlap as redundancy, not emphasis. Compress by deletion, not summarization-in-place:
- State each relationship, rule, location, and prop exactly once, at the point it was established or last changed.
- Merge sequential scenes into one outcome sentence (cause, outcome, consequence); do not replay beat-by-beat action.
- Keep a named detail only when it changes behavior later; delete names of one-off items, garments, purchases, and body actions.
### CRITICAL TEMPORAL RULES:
1. **No Historical Rewriting:** <prior_context> is your established, immutable baseline history. Do NOT re-summarize, duplicate, or re-write any events, dates, or details already recorded in <prior_context>.
2. **Strict Delta Scoping:** Your output must ONLY summarize the new events occurring within <narratives_to_consolidate>.
3. **Appended Continuity:** Structure the output so that it chronologically and seamlessly appends directly to the end of <prior_context> without looking back or repeating past timelines.
4. **Temporal Anchors:** Preserve lower-layer anchors such as [msgs 100-120; current 2024-12-03 09 Wed]. Keep hour-level 24-hour timestamps exactly when provided. Do not reduce inferable absolute timing to vague relative timing; future goals/plans should retain explicit date/hour anchors when available. Each source narrative is prefixed with a scene-time anchor like [msgs X-Y; current YYYY-MM-DD HH ddd]; treat that anchor's date AS the scene's "today" for that passage, compute every relative word in that narrative against it, and emit absolute dates in your output. Bare weekday names (e.g. "Friday") are forbidden; write the full calendar date instead of a relative word.
### PROSE-FOLDING RULES:
Fold in only major plot-arc changes from the source memories that affect future events; ignore minor inventory items, temporary rules, and transient positions.
Do not output key-value lines, tables, bullets, or other structured state syntax.
Omit stale transient scene facts and static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.
Omit ephemeral trivia: physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, and momentary pose/arousal/mood counters. Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by an unresolved hook.
### SYNTHESIS PRIORITIES:
1. **Plot Skeleton:** The beats whose consequences still shape the present, with the cause-to-effect chain intact; prefer shrinking and merging to deletion, and delete a beat only when the length contract leaves no room.
2. **Core Moments:** Keep ${CORE_MOMENT_TYPES}: moments that durably changed feelings, trust, power, or perception; capture the moment and its meaning, never the scene replay.
3. **Open Threads:** Unresolved hooks, debts, promises, dormant tensions, and what the characters intend next. Revise each thread in place to its current status; stale is not resolved; drop a thread only when it is fully resolved with no residual consequences. Record a recurring flash, fantasy, or dream pattern only as its psychological meaning and narrative potential, never the image itself; the meaning is the thread.
4. **Deduplication:** Omit transitional actions, low-impact micro-movements, scene replay, and momentary dialogue loops.
5. **Abstraction:** Merge repeated related beats into one cumulative state change, boundary, rule, or outcome.
${PROMOTION_MODERATE_MACRO_RULES}`,
    criticalRules: PROMOTION_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_PROMO,
});

export const DEFAULT_PROMOTION_REPAIR_PROMPT = buildUserPrompt({
    inputBlocks: PROMOTION_INPUT_BLOCKS,
    schemaBlock: `Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Never use second-person. ${ANTI_RUN_ON_RULE}>`,
    taskRules: `Repair the previous Layer 1+ promotion draft. It failed the compression guard, so rewrite the same source memories more abstractly instead of adding detail.
Keep only durable macro-level chronology, current position, relationship changes, core emotional moments, permanent rules, and open threads (unresolved hooks, debts, promises); revise threads in place and never silently drop one with residual consequences; do not output lists, markdown, commentary, or key-value syntax.
Resolve every relative time word against the source snippets' scene-date anchors and emit absolute dates only; never leave a bare relative time word.`,
    criticalRules: PROMOTION_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_PROMO,
});

const AUDITOR_INPUT_BLOCKS = `<player_name>
{{player_name}}
</player_name>

<prior_continuity_state>
{{context_str}}
</prior_continuity_state>

<latest_exchanges>
{{story_txt}}
</latest_exchanges>`;

/**
 * Per-pair flag vocabulary only; this module (JavaScript) is the sole writer
 * of bond/sparks/grudge numbers, so the schema forbids numeric counters.
 */
const AUDITOR_SCHEMA_BLOCK = `Output exactly one JSON object with these sections:

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
      "status": "<on-screen state or off-screen location>",
      "body_state": "<condition>",
      "fibs": "<lies this character has told, or ''>",
      "aware": "<secrets this character knows, or ''>"
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
Name rule: ${AUDITOR_NAME_RULE}
Discovery rule: ${AUDITOR_DISCOVERY_RULE}`;

const AUDITOR_CRITICAL_RULES = `${AUDITOR_PRESERVATION_RULES}
You never do arithmetic: bond scores, sparks, grudges, gates, and turn counting are computed by JavaScript from your booleans.
Write the output mainly in English; short non-English names, titles, and source-language phrases are allowed.`;

export const DEFAULT_AUDITOR_SYSTEM_PROMPT = buildSystemPrompt(
    'Role: continuity auditor and database manager. You evaluate the latest exchanges and emit one full-state JSON rewrite. You never write narrative prose.',
    `Bond engine: judge each exchange per pair and flag it with the five booleans only (positive_interaction, slight, insult, betrayal, apology).
Agenda engine: on-screen NPCs update task progress in place; off-screen NPCs keep or advance their step counter.
Canonical names: ${AUDITOR_NAME_RULE}
NPC discovery: ${AUDITOR_DISCOVERY_RULE}
GM notebook contract: [R] reminders are dynamic rules and persistent constraints; [T] threads are commitments, deadlines, and pending arcs; [S] secrets are asymmetric knowledge: who knows and who is ignorant.
Physics extractor: record room/environment, relative positioning and distance, posture, contact points, and clothing alterations.
Anti-omniscient verification: if a character was not present when an event happened, that event is an [S] secret noting who knows and who is ignorant.`,
);

export const DEFAULT_AUDITOR_USER_PROMPT = buildUserPrompt({
    inputBlocks: AUDITOR_INPUT_BLOCKS,
    schemaBlock: AUDITOR_SCHEMA_BLOCK,
    taskRules: `Rewrite the ENTIRE state object from <prior_continuity_state> plus what <latest_exchanges> changed. Output is a full state rewrite, not a delta.
Keep the exchanges' consequences only: permanent lore, resolved threads, and static card facts stay out of the dynamic state.
Physical gates and intimacy tiers are read-only context; never emit them.`,
    criticalRules: AUDITOR_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_AUDITOR,
});
