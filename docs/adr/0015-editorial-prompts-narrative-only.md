# Editorial hierarchy in the default summarizer prompts

> Supersedes ADR-0005 (2026-09-20); restates the decision as it stands since
> issue #26 removed the `[STATE]` snapshot engine. The contract is
> narrative-only.

The summarizer_v1.1 community prompt (a rolling 7-section editorial document with Core Memories, Plot Summary, Emotional Arc, Character States, Inside Jokes, Secrets, and Future Hooks) was adapted into the default Layer 0 and promotion prompt rules instead of being adopted as an output format. v1.1's real value — its salience hierarchy (firsts/shifts/breaks, salient moments vs excess tissue, cause-to-effect chains) and its thread-maintenance rules (stale is not resolved, revise threads in place, recurring flash/dream patterns recorded as meaning rather than image) — is distilled into `LAYER0_DURABILITY_RULES`, the promotion synthesis priorities, and both repair prompts (src/foundation/prompt-constants.js).

The pipeline hard-binds to a narrative-only output contract: exactly one full-line `[NARRATIVE]` header with a non-empty prose body (`validateLayer0StructuralContract`, src/core/layer0-compression.js) plus one trailing `current_date_time: YYYY-MM-DD HH ddd` scene-time line, its weekday re-derived from the ISO date in UTC (`SCENE_TIME_LINE_RE`, src/core/snippet-metadata.js). The Layer 0 size guard and the integrity checks of Output Hygiene enforce the contract; the promotion input is one consolidated `[NARRATIVE]` paragraph under a hard sentence cap. There is no `[STATE]` section, no state compactor, and no snapshot engine: the scene-time key is the only structured line.

Rejected: a 7-section output format — a memory-model rewrite, not a prompt swap. Monotone never-delete anchor persistence — memory must compress, so omission means dropped, and the salience rules carried in prose are the only protection a salient moment gets; they exist precisely to decide what may not drop.

Defaults policy: custom-edited prompt textareas keep their text; default-preset users receive new wording without stored-value detection.
