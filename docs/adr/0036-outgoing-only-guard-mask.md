# Guard masking is outgoing-only at the main-prompt seam

Only outgoing copy is rewritten at the `GENERATE_AFTER_DATA` seam after ST regex scripts: `U+0020` becomes `$$` in user and assistant content and, with memory masking on, the Memory slot — never system roles, speaker names, or the Continuity slot. Storing `$$` would pollute history and force a decode path (ADR-0037).

## Considered Options

- **Store `$$` in chat, decode for the summarizer** — rejected: every stored turn needs migration, each path grows an unmask step, and a missed decode leaks `$$`.
