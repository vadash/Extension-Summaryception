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
