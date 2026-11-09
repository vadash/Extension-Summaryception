# Guard masking is outgoing-only at the main-prompt seam

Chat storage and stored memories keep normal spaces; the extension rewrites only the outgoing main-prompt copy at the `GENERATE_AFTER_DATA` seam (after ST regex scripts), replacing every `U+0020` with `$$` in user and assistant message content plus, when memory masking is enabled, the Memory slot text, while skipping system roles, speaker names, and the Continuity slot, because storing `$$` would pollute history and force a decode path while the summarizer family must always read normal spaces.

## Considered Options

- **Store `$$` in chat and decode for the summarizer** — rejected: every stored turn needs migration, the Passage/Memory Body/Auditor paths each grow an unmask step, and a missed decode leaks `$$` into snippets.
