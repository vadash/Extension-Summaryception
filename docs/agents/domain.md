# Domain Docs

How skills consume this repo's domain documentation.

## Before exploring, read

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: the ADRs that touch the area you're about to work in.

If either is missing, proceed silently; don't flag its absence.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids. A missing concept is a note for `/domain-modeling`, not an invention.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it rather than silently overriding:
> _Contradicts ADR-0001 (host facade), but worth reopening because…_

## Recording decisions: replace, don't patch

A decision change writes a new ADR that restates the complete decision still in
force; the predecessor becomes a stub (status header, 2–4 sentence epitaph,
pointer). Statuses are binary — current, or `Superseded by NNNN (date)`: no
"amends", no "superseded in part", no full bodies kept for background. Code and
test citations point only at current ADRs; citing a stub is a bug. An ADR covers
one decision unit, so a change to any part replaces the whole document — which
is what makes partial supersession impossible.
