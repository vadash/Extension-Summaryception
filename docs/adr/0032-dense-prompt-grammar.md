# Model-facing prompts share one dense tag grammar

Every prompt Summaryception authors follows one grammar: flat `key: value` lines, `trigger -> replacement` in place of every ban, single lowercase root tags, and single spaces between single-word items. The assembler tags are `<role>`, `<inv>`, `<in>`, `<out>`, `<task>`, `<rules>`; literals the pipeline parses keep their spelling; stored Snippets stay bare prose.

## Consequences

`tests/prompt-grammar.test.js` pins the layer0 section order, the request-message order, and system-message purity.
