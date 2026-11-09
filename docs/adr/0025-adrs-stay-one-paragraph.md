# ADRs stay to a paragraph unless a section earns its place

An ADR records a decision and why: a title and one to three sentences. Sections appear only when they carry what the paragraph cannot, and `Considered Options` lists only alternatives a future reader would plausibly propose again. Supersession is `status: superseded by ADR-NNNN` frontmatter, or deletion for a retired row in the README when the successor restates the decision whole.

## Considered Options

- **Keep the refactor narrative.** Rejected: git and the commit subject store it; 83% of ADRs grew past the shape.
- **Cap total words.** Rejected: ADR-0017 carries six decisions, so a cap forces a seventh file or drops content.
