import {
    buildSystemPrompt,
    buildUserPrompt,
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
} from './prompt-parts.js';

export const ENGLISH_FIRST_LANGUAGE_RULE =
    'Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.';

export const ANTI_RUN_ON_RULE =
    'Write in short, direct sentences. Prefer periods over commas and semicolons; do not chain actions together with commas, semicolons, or conjunctions into run-on sentences. Limit each sentence to roughly two actions or events.';

export const STATE_SNAPSHOT_SOFT_TARGET_TOKENS = 700;
export const STATE_SNAPSHOT_MAX_TOKENS = 1000;
/**
 * Highest [STATE] token count still eligible for deterministic compaction
 * before falling back to a full LLM retry. Overshoots up to this ceiling are
 * trimmed in-process; anything larger is treated as unrepairable and retried.
 * Scaled with the raised hard cap (1000): 1667 holds the ~1.67× ceiling ratio
 * so modular multi-category overshoots still land in-process.
 */
export const STATE_SNAPSHOT_REPAIR_CEILING_TOKENS = 1667;
/**
 * Char budget the deterministic state compactor aims for. Kept below the
 * hard max so accepted trims land comfortably under STATE_SNAPSHOT_MAX_TOKENS
 * even for denser scripts (Cyrillic averages ~3.5 chars/token vs ~4.2 English).
 * Scaled with the hard cap (1000/600 = 1.67× from the previous 2640).
 */
export const STATE_SNAPSHOT_COMPACTION_TARGET_CHARS = 4400;
export const STATE_SNAPSHOT_MAX_CHARS = 5000;
export const LAYER0_DURABILITY_RULES =
    'Preserve each major durable beat once. Collapse repeated actions, physical interaction, or dialogue loops into one outcome sentence. Omit brands, shopping routes, meals, clothing, poses, body mechanics, ordinary props, and temporary physical conditions unless they create a lasting decision, rule, resource, injury, or unresolved hook.';

export const STATE_DEDUPLICATION_RULES =
    'Use at most one line per supported key. Do not repeat the same fact across bonds, chekhov, gm_notes, inventory, or location. Bonds holds one pair per line. Chekhov holds one bullet per line. Inventory tracks the player only. GM Notes logs only what no other category owns.';

export const PROMOTION_MODERATE_MACRO_RULES =
    'Keep named people and places only when needed to understand a lasting relationship, obligation, location, or unresolved hook. Drop ages, brands, shopping routes, meals, clothing, one-off supplies, dialogue, and mechanical scene replay unless future continuity depends on them. Prefer cumulative outcomes over a list of scene beats.';

/**
 * Prose date format rule, shared across Layer 0 and Layer 1+ prompts.
 * The current year is already carried in [STATE]/[NARRATIVE]'s current_date_time,
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
    "[CURRENT STATE] = active facts. [CHRONOLOGY] = past events, oldest to newest. [X-Y@YYYY-MM-DDTHH] = source messages X-Y; scene time at Y also serves as that passage's reference date; resolve any relative time words (tomorrow, today, in N days, next/bare weekday, this evening) in the adjacent narrative against it.\n" +
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
    'Role: narrative-state dual compressor. Output a [NARRATIVE] paragraph and a [STATE] key-value block.',
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

const LAYER0_SCHEMA_BLOCK = `Output exactly two sections:

[NARRATIVE]
<one dense chronological prose paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags here. ${ANTI_RUN_ON_RULE}>
Resolve any relative time reference in the passage (tomorrow, today, in N days, next/bare weekday, this evening) against the known scene date and write the RESOLVED ABSOLUTE DATE inline in the prose instead of the relative word. Never leave a bare relative time word in the narrative.
${PROSE_DATE_FORMAT_RULE}
${LAYER0_DURABILITY_RULES}

[STATE]
Rewrite the COMPLETE current snapshot as key: value lines. Omission means the fact is no longer active or important enough for state; omitted values are not inherited.
Do NOT extract static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions. Those belong in character cards or lorebooks.
Do NOT write descriptive sentences in the state block. Use concise keys and values only.
Always include temporal key:
- current_date_time: YYYY-MM-DD HH ddd
Use 24-hour, hour-level precision only, e.g. 2024-07-04 16 Thu. Derive the ddd weekday from the ISO date (2024-07-04 = Thu); never carry it over from the prior snapshot when the date changed. Normalize from raw bracket headers or passage timestamps when present. Drop minutes instead of preserving them.
If no explicit time appears in the passage, carry forward the prior current_date_time if known.

Use only these keys and omit empty categories:
{{state_schema}}`;

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
</narratives_to_consolidate>

<source_state>
{{source_state}}
</source_state>`;

const PROMOTION_CRITICAL_RULES = `${ENGLISH_FIRST_LANGUAGE_RULE}
${PROSE_DATE_FORMAT_RULE}
${ANTI_RUN_ON_RULE}`;

export const DEFAULT_SUMMARIZER_USER_PROMPT = buildUserPrompt({
    inputBlocks: LAYER0_INPUT_BLOCKS,
    schemaBlock: LAYER0_SCHEMA_BLOCK,
    taskRules: `Compress only the essential narrative progression from <passage_in_question>, then rewrite the complete compact current-state snapshot at the end of that passage using <prior_context> as the baseline.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
Keep [STATE] compact; follow the sentence and line caps provided at the end of this prompt. Put the most important facts first within each value.
${STATE_DEDUPLICATION_RULES}
Durable state belongs in [STATE]; ephemeral trivia does not. Do NOT preserve clothing, pose, momentary mood/arousal, ordinary props, completed errands, resolved hooks, physiological or sex counters, consumed food/drink, or soiled/used/disposed temporary items.
Do not narrate events inside [STATE]. Only facts that remain useful after the recent verbatim window is gone.`,
    criticalRules: LAYER0_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_L0,
});

export const DEFAULT_SUMMARIZER_REPAIR_PROMPT = buildUserPrompt({
    inputBlocks: LAYER0_INPUT_BLOCKS,
    schemaBlock: LAYER0_SCHEMA_BLOCK,
    taskRules: `The previous Layer 0 summary attempt failed output validation. Repair the response by summarizing the same passage again with stricter formatting.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
Omission removes a fact rather than preserving it. Exclude transient scene detail, completed tasks, resolved hooks, and ordinary items.
Keep the state compact; follow the sentence and line caps provided at the end of this prompt.
${STATE_DEDUPLICATION_RULES}
Always include current_date_time using YYYY-MM-DD HH ddd, carrying forward the prior value if no explicit time appears.
Do not include prose, bullets, tables, duplicate section headers, markdown, or commentary inside [STATE].`,
    criticalRules: LAYER0_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_L0,
});

export const DEFAULT_PROMOTION_SYSTEM_PROMPT = buildSystemPrompt(
    'Role: prose-folding memory synthesizer. Fold durable state into narrative continuity, then output one consolidated [NARRATIVE] paragraph only.',
    'No [STATE] block, no preamble, no commentary, no markdown.\nNever use second-person pronouns in the output.\nWrite the output mainly in English; short non-English names, titles, and source-language phrases are allowed.',
);

export const DEFAULT_PROMOTION_USER_PROMPT = buildUserPrompt({
    inputBlocks: PROMOTION_INPUT_BLOCKS,
    schemaBlock: `Output exactly one section:

[NARRATIVE]
One single prose paragraph containing AT MOST {{max_sentences_word}} ({{max_sentences}}) sentences total. Summarize major plot outcomes only.
<one dense third-person chronological prose paragraph. Never use second-person. Do not output [STATE]. ${ANTI_RUN_ON_RULE}>`,
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
The <source_state> block contains dynamic facts extracted from the source memories. Do NOT list every item from <source_state>. Fold in only major plot-arc changes that affect future events; ignore minor inventory items, temporary rules, and transient positions.
Do not output a [STATE] block, key-value lines, tables, bullets, or structured state syntax.
Omit stale transient scene facts and static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.
Omit ephemeral trivia: physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, and momentary pose/arousal/mood counters. Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by an unresolved hook.
### SYNTHESIS PRIORITIES:
1. **Durable Narrative State:** Permanent changes to relationships, agreements, rules, and core character development.
2. **Unresolved Hooks:** Where the characters are currently positioned, what they intend to do next, or pending immediate agreements.
3. **Deduplication:** Omit transitional actions, low-impact micro-movements, scene replay, and momentary dialogue loops.
4. **Abstraction:** Merge repeated related beats into one cumulative state change, boundary, rule, or outcome.
${PROMOTION_MODERATE_MACRO_RULES}`,
    criticalRules: PROMOTION_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_PROMO,
});

export const DEFAULT_PROMOTION_REPAIR_PROMPT = buildUserPrompt({
    inputBlocks: PROMOTION_INPUT_BLOCKS,
    schemaBlock: `Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Never use second-person. Do not output [STATE]. ${ANTI_RUN_ON_RULE}>`,
    taskRules: `Repair the previous Layer 1+ promotion draft. It failed the compression guard, so rewrite the same source memories more abstractly instead of adding detail.
Keep only durable macro-level chronology, current position, relationship/state changes, permanent rules, and unresolved hooks; do not output [STATE], lists, markdown, commentary, or key-value syntax.
Resolve every relative time word against the source snippets' scene-date anchors and emit absolute dates only; never leave a bare relative time word.`,
    criticalRules: PROMOTION_CRITICAL_RULES,
    triggerLine: EXECUTION_TRIGGER_PROMO,
});
