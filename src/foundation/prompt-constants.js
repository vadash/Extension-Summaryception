export const ENGLISH_FIRST_LANGUAGE_RULE =
    'Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.';

export const ANTI_RUN_ON_RULE =
    'Write in short, direct sentences. Prefer periods over commas and semicolons; do not chain actions together with commas, semicolons, or conjunctions into run-on sentences. Limit each sentence to roughly two actions or events.';

export const STATE_SNAPSHOT_MODE = 'snapshot-v1';
export const STATE_SNAPSHOT_SOFT_TARGET_TOKENS = 200;
export const STATE_SNAPSHOT_MAX_TOKENS = 300;
export const STATE_SNAPSHOT_REPAIR_CEILING_TOKENS = 360;
export const STATE_SNAPSHOT_MAX_CHARS = 1200;

export const LAYER0_DURABILITY_RULES =
    'Preserve each major durable beat once. Collapse repeated actions, physical interaction, or dialogue loops into one outcome sentence. Omit brands, shopping routes, meals, clothing, poses, body mechanics, ordinary props, and temporary physical conditions unless they create a lasting decision, rule, resource, injury, or unresolved hook.';

export const STATE_DEDUPLICATION_RULES =
    'Use at most one line per supported key. Do not repeat the same fact across characters, dynamics, constraints, hooks, or inventory. Characters may include only presence and consequential persistent conditions. Inventory is plot-critical ownership or access only. Hooks are unresolved future-affecting threads only.';

export const PROMOTION_MODERATE_MACRO_RULES =
    'Keep named people and places only when needed to understand a lasting relationship, obligation, location, or unresolved hook. Drop ages, brands, shopping routes, meals, clothing, one-off supplies, dialogue, and mechanical scene replay unless future continuity depends on them. Prefer cumulative outcomes over a list of scene beats.';

export const DEFAULT_INJECTION_TEMPLATE =
    '<summaryception_memory>\n' +
    'Compressed continuity. Newer verbatim chat and the current user message take priority.\n' +
    "[CURRENT STATE] = active facts. [CHRONOLOGY] = past events, oldest to newest. [X-Y@YYYY-MM-DDTHH] = source messages X-Y; scene time at Y also serves as that passage's reference date — resolve any relative time words (tomorrow, today, in N days, next/bare weekday, this evening) in the adjacent narrative against it.\n" +
    '{{summary}}\n' +
    '</summaryception_memory>';

export const DEFAULT_SUMMARIZER_SYSTEM_PROMPT =
    'Role: narrative-state dual compressor. Output a [NARRATIVE] paragraph and a [STATE] key-value block. No preamble, no commentary.';

export const DEFAULT_SUMMARIZER_USER_PROMPT = `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Compress only the essential narrative progression from <passage_in_question>, then rewrite the complete compact current-state snapshot at the end of that passage using <prior_context> as the baseline.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
${ENGLISH_FIRST_LANGUAGE_RULE}

Output exactly two sections:

[NARRATIVE]
<one dense chronological prose paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags here. ${ANTI_RUN_ON_RULE}>
Resolve any relative time reference in the passage (tomorrow, today, in N days, next/bare weekday, this evening) against the known scene date and write the RESOLVED ABSOLUTE DATE inline in the prose instead of the relative word. Never leave a bare relative time word in the narrative.
${LAYER0_DURABILITY_RULES}

[STATE]
Rewrite the COMPLETE current snapshot as key: value lines. Omission means the fact is no longer active or important enough for state; omitted values are not inherited.
Do NOT extract static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions. Those belong in character cards or lorebooks.
Do NOT write descriptive sentences in the state block. Use concise keys and values only.
Always include temporal key:
- current_date_time: YYYY-MM-DD HH ddd
Use 24-hour, hour-level precision only, e.g. 2024-12-03 06 Wed. Normalize from raw bracket headers or passage timestamps when present. Drop minutes instead of preserving them.
If no explicit time appears in the passage, carry forward the prior current_date_time if known.

Use only these keys and omit empty categories:
- current_date_time: <YYYY-MM-DD HH ddd>
- location: <current place>
- characters: <present or immediately relevant names and consequential conditions only>
- dynamics: <active relationships, roles, trust, hostility, or social standing>
- constraints: <active rules, obligations, permissions, deadlines, or persistent limitations>
- hooks: <unresolved goals, threats, secrets, or near-future plans>
- inventory: <plot-critical carried items, controlled resources, or access only>

Keep [STATE] near ${STATE_SNAPSHOT_SOFT_TARGET_TOKENS} tokens when the RP is complex and never exceed ${STATE_SNAPSHOT_MAX_TOKENS} tokens. Use fewer tokens when the state is simple. Put the most important facts first within each value.
${STATE_DEDUPLICATION_RULES}
Durable state belongs in [STATE]; ephemeral trivia does not. Do NOT preserve clothing, pose, momentary mood/arousal, ordinary props, completed errands, resolved hooks, physiological or sex counters, consumed food/drink, or soiled/used/disposed temporary items.

Do not narrate events inside [STATE]. Only facts that remain useful after the recent verbatim window is gone.`;

export const DEFAULT_SUMMARIZER_REPAIR_PROMPT = `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

The previous Layer 0 summary attempt failed output validation. Repair the response by summarizing the same passage again with stricter formatting.
${ENGLISH_FIRST_LANGUAGE_RULE}

Output exactly two sections and nothing else:

[NARRATIVE]
<one dense chronological prose paragraph covering only essential events, actions, dialogue, and outcomes from the passage. Never use second-person pronouns. ${ANTI_RUN_ON_RULE} Resolve any relative time reference (tomorrow, today, in N days, next/bare weekday, this evening) against the known scene date and write the resolved absolute date inline instead of the relative word; never leave a bare relative time word.>
${LAYER0_DURABILITY_RULES}

[STATE]
Rewrite the complete compact current snapshot using only current_date_time, location, characters, dynamics, constraints, hooks, and inventory.
Omission removes a fact rather than preserving it. Exclude transient scene detail, completed tasks, resolved hooks, and ordinary items.
Keep the state near ${STATE_SNAPSHOT_SOFT_TARGET_TOKENS} tokens and never exceed ${STATE_SNAPSHOT_MAX_TOKENS} tokens.
${STATE_DEDUPLICATION_RULES}
Always include current_date_time using YYYY-MM-DD HH ddd, carrying forward the prior value if no explicit time appears.
Do not include prose, bullets, tables, duplicate section headers, markdown, or commentary inside [STATE].`;

export const DEFAULT_PROMOTION_SYSTEM_PROMPT =
    'Role: prose-folding memory synthesizer. Fold durable state into narrative continuity, then output one consolidated [NARRATIVE] paragraph only. No [STATE], preamble, commentary, or markdown.';

export const DEFAULT_PROMOTION_USER_PROMPT = `<player_name>
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
</source_state>

Consolidate the NEW events from <narratives_to_consolidate> and any durable facts from <source_state> into a highly compressed continuation that follows the runtime Layer 1+ target length.
${ENGLISH_FIRST_LANGUAGE_RULE}

### CRITICAL TEMPORAL RULES:
1. **No Historical Rewriting:** <prior_context> is your established, immutable baseline history. Do NOT re-summarize, duplicate, or re-write any events, dates, or details already recorded in <prior_context>.
2. **Strict Delta Scoping:** Your output must ONLY summarize the new events occurring within <narratives_to_consolidate>.
3. **Appended Continuity:** Structure the output so that it chronologically and seamlessly appends directly to the end of <prior_context> without looking back or repeating past timelines.
4. **Temporal Anchors:** Preserve lower-layer anchors such as [msgs 100-120; current 2024-12-03 09 Wed]. Keep hour-level 24-hour timestamps exactly when provided. Do not reduce inferable absolute timing to vague relative timing; future goals/plans should retain explicit date/hour anchors when available. Each source narrative is prefixed with a scene-time anchor like [msgs X-Y; current YYYY-MM-DD HH ddd]; treat that anchor's date AS the scene's "today" for that passage, compute every relative word in that narrative against it, and emit only absolute dates in your output. Bare weekday names (e.g. "Friday") are forbidden — write the full date (e.g. 2024-07-12 Fri) instead of a relative word.

### PROSE-FOLDING RULES:
The <source_state> block contains dynamic facts extracted from the source memories. Fold any still-durable facts, inventory changes, counters, relationship changes, current positions, and unresolved hooks directly into the narrative prose.
Do not output a [STATE] block, key-value lines, tables, bullets, or structured state syntax.
Omit stale transient scene facts and static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions.
Omit ephemeral trivia: physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, and momentary pose/arousal/mood counters. Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by an unresolved hook.

### SYNTHESIS PRIORITIES:
1. **Durable Narrative State:** Permanent changes to relationships, agreements, rules, and core character development.
2. **Unresolved Hooks:** Where the characters are currently positioned, what they intend to do next, or pending immediate agreements.
3. **Deduplication:** Omit transitional actions, low-impact micro-movements, scene replay, and momentary dialogue loops.
4. **Abstraction:** Merge repeated related beats into one cumulative state change, boundary, rule, or outcome.
${PROMOTION_MODERATE_MACRO_RULES}

### FORMAT:
Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Never use second-person. Do not output [STATE]. ${ANTI_RUN_ON_RULE}>`;

export const DEFAULT_PROMOTION_REPAIR_PROMPT = `<player_name>
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
</source_state>

Repair the previous Layer 1+ promotion draft. It failed the compression guard, so rewrite the same source memories more abstractly instead of adding detail.
${ENGLISH_FIRST_LANGUAGE_RULE}

Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Keep only durable macro-level chronology, current position, relationship/state changes, permanent rules, and unresolved hooks. Do not output [STATE], lists, markdown, commentary, or key-value syntax. ${ANTI_RUN_ON_RULE} Resolve every relative time word against the source snippets' scene-date anchors and emit absolute dates only; never leave a bare relative time word.>`;
