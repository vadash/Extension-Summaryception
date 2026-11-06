# Summarizer style rules use construction families, not vocabulary bans

The 2026-11 before/after audit of two same-scenario exports showed zero banned-word violations under both prompt sets, while the real drift was structural: semicolon chains surviving an existing ban, transliterated quotes replacing verbatim source-script dialogue, somatic tallies kept despite the sex-counter rule, and one comparative construction (first-ever framings) echoing across snippets. The default Layer 0 and promotion prompts therefore gain only construction-family substitution rules (tricolons, apophasis, litotes, anaphora loops, personification, em-dash joins, melodrama formulas, clause limits), a somatic-tally drop line, a verbatim-quote language rule, and a one-framing cap with prior-relative rewording — and deliberately no banned-vocabulary list, which is why none may be proposed back onto these prompts without new audit evidence.

## Considered Options

- **Copy the roleplay preset's banned-word list into the summarizer prompts** — zero occurrences in both audits, a token tax on every call, and the Refusal Guard already exempts quoted in-story dialogue from lexical patterns, so the list has nothing to catch.
- **Add mechanical gate checks for the style rules now** — deferred: re-run the same scenario after the prompt change and only extend the repair gate (semicolon as sentence break, clause cap) if violations persist.

## Consequences

Rules stay RP-agnostic: no scenario nouns, construction families with generic examples only, each written in the Prompt Grammar substitution shape so `tests/prompt-grammar.test.js` keeps passing. Style rules ride prompt text alone this pass; a repeat violation in the next audit is the trigger to revisit enforcement.
