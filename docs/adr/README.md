# ADRs

Decisions live here as `NNNN-slug.md`, one paragraph each (ADR-0025; the shape and the criteria for offering one are in `docs/agents/domain.md`).

A superseded decision that keeps its file states its successor in `status:` frontmatter. A superseded decision whose successor restates it whole is **retired**: the file is deleted and its number moves to the table below.

## Retired numbers

Numbers listed here were used and are spent — nothing may reuse them. The file is gone because its successor restates the decision whole, so the title is the only remaining record of what it decided, and the successor is the authority in force. `tests/adr-shape.test.js` treats these numbers as resolvable citations, asserts each row's successor is still a live file, and asserts no live file claims a retired number.

| Number | Title | Superseded by |
| ------ | ----- | ------------- |
| 0004 | Structured run outcomes cross the core seam; entry renders all notices | 0019 |
| 0005 | Editorial hierarchy as the default summarizer prompts | 0015 |
| 0007 | Swiped Exchanges audit after settlement, not at swipe time | 0017 |
| 0010 | Continuity Checkpoint in message extra, not chat metadata | 0017 |
| 0011 | No swipes, pre-user anchor bound, single-call audit | 0017 |
| 0012 | Latest checkpoint wins, no validation | 0017 |
| 0013 | Regenerated replies drop their checkpoint at generation start | 0017 |
| 0014 | Continuity Checkpoint: payload in message extra, latest wins | 0017 |

ADR-0007, ADR-0010, ADR-0011, ADR-0012, and ADR-0013 were superseded first by ADR-0014, which ADR-0017 then consolidated; the table names the authority in force rather than the intermediate step.
