# Editorial hierarchy as the default summarizer prompts

> Superseded by ADR-0015 (2026-09-20). Distilled summarizer_v1.1's editorial
> salience and thread-maintenance rules into the default Layer 0 and promotion
> prompt rules, binding the pipeline to a `[NARRATIVE]`+`[STATE]` output
> contract. Issue #26 later removed the `[STATE]` half; ADR-0015 restates the
> surviving decision as the narrative-only contract in force today.
