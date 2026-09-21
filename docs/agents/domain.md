# Domain Docs

How skills consume this repo's domain documentation, and how an ADR gets written.

## Before exploring, read

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: the ADRs that touch the area you're about to work in.

If either is missing, proceed silently; don't flag its absence.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids. A missing concept is a note for `/domain-modeling`, not an invention.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it rather than silently overriding:
> _Contradicts ADR-0001 (host facade), but worth reopening because…_

## Writing an ADR

Offer one only when all three hold: the decision is hard to reverse, it is surprising without context, and it was a real trade-off. A refactor that only moves code between modules fails the first two; that belongs in the commit message, not in `docs/adr/`.

Keep it to a title and one to three sentences. Add `Decision`, `Considered Options`, or `Consequences` only when a section carries something the paragraph cannot, and list only the alternatives a future reader would plausibly propose again. Record supersession as `status: superseded by ADR-NNNN` frontmatter, never as a prose banner.

This restates `ADR-FORMAT.md` (the domain-modeling skill), and ADR-0025 records the decision. `tests/adr-shape.test.js` enforces the mechanical half.
