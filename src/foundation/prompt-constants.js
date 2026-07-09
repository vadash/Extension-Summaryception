export const DEFAULT_INJECTION_TEMPLATE =
    '<summaryception_memory>\n' +
    'This is condensed continuity memory from older chat turns.\n\n' +
    '[HIERARCHY OF TRUTH]\n' +
    "1. [CURRENT STATE] contains active, durable facts (location, inventory, active rules, constraints, and physical limitations). This section is the absolute truth for the current scene. If [CHRONOLOGY] or the user's input contradicts this section, [CURRENT STATE] takes strict priority.\n" +
    '2. [CHRONOLOGY] contains older narrative history. Use it strictly for background context and past events. Entries are ordered older to newer; an anchor like [msgs X-Y; current T] means the entry summarizes chat messages X through Y, and T is the scene time at the end of message Y.\n\n' +
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

Compress only the essential narrative progression and changed durable state from <passage_in_question> to coherently continue <prior_context>.
If the prose uses 2nd person ('you'), map it directly to <player_name>. Never use second-person pronouns in the output.
Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.

Output exactly two sections:

[NARRATIVE]
<one dense chronological prose paragraph covering ONLY events, actions, dialogue, and outcomes. Do NOT include factual parameters like dates, inventory lists, or status flags here.>

[STATE]
Extract only dynamic state variables that CHANGED or became newly relevant in this passage. Format as key: value, one per line.
Omit unchanged state. Omission means the previous value is preserved.
Do NOT extract static character background/profile facts such as origins, hometowns, backstory, personality traits, age, species, nationality, or static job descriptions. Those belong in character cards or lorebooks.
Do NOT write descriptive sentences in the state block. Use concise keys and values only.
To delete a resolved or emptied variable, write: key: none
Always include temporal key:
- current_date_time: YYYY-MM-DD HH ddd
Use 24-hour, hour-level precision only, e.g. 2024-12-03 06 Wed. Normalize from raw bracket headers or passage timestamps when present. Drop minutes instead of preserving them.
If no explicit time appears in the passage, carry forward the prior current_date_time if known.

Common keys (use what is relevant, invent new ones if needed):
- current_date_time: <YYYY-MM-DD HH ddd>
- location: <current place>
- characters: <name: brief status, ...>
- inventory: <active items/equipment>
- dynamics: <relationship/power state>
- hooks: <unresolved plans/threats>
- counters: <only unresolved/pending/owed obligation counters>

Durable state belongs in [STATE]; ephemeral trivia does not. Do NOT preserve physiological or sex counters, consumed food/drink, soiled/used/disposed temporary items, or momentary pose/arousal/mood counters. Preserve obligation counters only when clearly unresolved, pending, owed, or referenced by an unresolved hook.

Do not narrate events inside [STATE]. Only current facts. If nothing changed, output only current_date_time below [STATE].`;

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
Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.

Output exactly two sections and nothing else:

[NARRATIVE]
<one dense chronological prose paragraph covering only essential events, actions, dialogue, and outcomes from the passage. Never use second-person pronouns.>

[STATE]
Extract only changed or newly relevant durable state as concise key: value lines.
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
Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.

### CRITICAL TEMPORAL RULES:
1. **No Historical Rewriting:** <prior_context> is your established, immutable baseline history. Do NOT re-summarize, duplicate, or re-write any events, dates, or details already recorded in <prior_context>.
2. **Strict Delta Scoping:** Your output must ONLY summarize the new events occurring within <narratives_to_consolidate>.
3. **Appended Continuity:** Structure the output so that it chronologically and seamlessly appends directly to the end of <prior_context> without looking back or repeating past timelines.
4. **Temporal Anchors:** Preserve lower-layer anchors such as [msgs 100-120; current 2024-12-03 09 Wed]. Keep hour-level 24-hour timestamps exactly when provided. Do not reduce inferable absolute timing to vague relative timing; future goals/plans should retain explicit date/hour anchors when available.

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

### FORMAT:
Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Never use second-person. Do not output [STATE].>`;

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
Write the output mainly in English. Short non-English names, titles, quoted terms, or source-language phrases are allowed when useful, but do not write Chinese prose or Han ideographs.

Output exactly one section:

[NARRATIVE]
<one dense third-person chronological prose paragraph. Keep only durable macro-level chronology, current position, relationship/state changes, permanent rules, and unresolved hooks. Do not output [STATE], lists, markdown, commentary, or key-value syntax.>`;
