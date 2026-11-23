# Guard masking is outgoing-only at the main-prompt seam

Only outgoing copy is rewritten at the `GENERATE_AFTER_DATA` seam after ST regex scripts: each run of horizontal whitespace becomes one `U+2800` BRAILLE PATTERN BLANK in user and assistant content and, with memory masking on, the Memory slot — never system roles, speaker names, or the Continuity slot. The mask runs only when the active model name carries `argon`, `opus`, or `gemini`, case-insensitive. Storing the mask would pollute history and force a decode path (ADR-0037).

## Considered Options

- **Store the mask character in chat, decode for the summarizer** — rejected: every stored turn needs migration, each path grows an unmask step, and a missed decode leaks the mask.
