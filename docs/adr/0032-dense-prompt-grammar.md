# Model-facing prompts share one dense tag grammar

Every prompt Summaryception authors — the nine default texts, both injection templates, and the runtime-appended fragments — follows one grammar: flat `key: value` lines, `trigger -> replacement` in place of every ban, single lowercase root tags, and single spaces between single-word items. The assembler tags shrink to `<role>`, `<inv>`, `<in>`, `<out>`, `<task>`, and `<rules>`; literals the pipeline parses keep their spelling (`current_date_time`, the Auditor JSON keys, `[R]/[T]/[S]`, `Name↔User`), and stored Snippets stay bare prose, so no chat is rewritten. Punctuation and tag tax is paid on every call while a substitution removes the attention priming a ban creates, which is why neither is allowed to creep back in.

## Considered Options

- **Flat block with no section tags** — cheapest by a few tokens, but it drops the ordering guarantee that keeps format rules adjacent to generation.
- **Keep the current multi-word tag names** — no rename cost, and the tag tax paid on every call.
- **Adopt the roleplay template wholesale** — the salience hierarchy transfers; the scene physics does not.

## Consequences

`tests/prompt-grammar.test.js` pins the layer0 section order, the request-message order, and system-message purity. Style rules (slashes, pluses, bare underscores, all-caps bracket headers, negations) stay prose convention only, enforced by review, not by scan.
