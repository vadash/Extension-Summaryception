# Editorial hierarchy in the default summarizer prompts

The default Layer 0 and promotion prompts adapt summarizer_v1.1's salience hierarchy (firsts, shifts, breaks; salient versus excess tissue; cause-to-effect chains) and thread-maintenance rules (stale is not resolved; revise threads in place) rather than its output format. The pipeline hard-binds to a narrative-only contract: exactly one `<narrative>` envelope with a non-empty prose body, whitespace only outside it, and one trailing `current_date_time: YYYY-MM-DD HH ddd` scene-time line. The Refusal Guard rejects a Refusal inside or instead of the envelope as retryable. Supersedes ADR-0005.

## Considered Options

- **Adopt v1.1's seven-section output format** — a memory-model rewrite.
- **Single full-line header without a close tag** — cheaper, but a Refusal wearing the header passes.

## Consequences

No `[STATE]` section, compactor, or snapshot engine: the scene-time key is the only structured line. Promotion input is one `<narrative>` paragraph under a sentence cap. Pre-envelope snippets read through the bracket-header strip; no chat is rewritten.
