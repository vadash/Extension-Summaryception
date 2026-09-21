# Editorial hierarchy in the default summarizer prompts

The default Layer 0 and promotion prompts adapt summarizer_v1.1's salience hierarchy (firsts, shifts, and breaks; salient moments versus excess tissue; cause-to-effect chains) and its thread-maintenance rules (stale is not resolved; revise threads in place) instead of adopting its output format; they live in `LAYER0_DURABILITY_RULES`, the promotion synthesis priorities, and both repair prompts (`src/foundation/prompt-constants.js`). The pipeline hard-binds to a narrative-only contract: exactly one full-line `[NARRATIVE]` header with a non-empty prose body (`validateLayer0StructuralContract`, `src/core/layer0-compression.js`) plus one trailing `current_date_time: YYYY-MM-DD HH ddd` scene-time line whose weekday is re-derived from the ISO date in UTC (`SCENE_TIME_LINE_RE`, `src/core/snippet-metadata.js`). Supersedes ADR-0005.

## Considered Options

- **Adopt v1.1's seven-section output format** — a memory-model rewrite, not a prompt swap.
- **Monotone never-delete anchor persistence** — memory must compress, so omission means dropped, and the salience rules exist precisely to decide what may not drop.

## Consequences

There is no `[STATE]` section, no state compactor, and no snapshot engine: the scene-time key is the only structured line. The promotion input is one consolidated `[NARRATIVE]` paragraph under a hard sentence cap, and the Layer 0 size guard together with the integrity checks of Output Hygiene enforce the contract.
