# ADRs stay to a paragraph unless a section earns its place

An ADR records that a decision was made and why: a title and one to three sentences. Sections (`Decision`, `Considered Options`, `Consequences`) appear only when they carry something the paragraph cannot, and `Considered Options` lists only the alternatives a future reader would plausibly propose again. Supersession is `status: superseded by ADR-NNNN` frontmatter when the file stays, and a row in the retired table in `docs/adr/README.md` when the successor restates the decision whole and the file is deleted; a retired number is never reused. The full shape and the criteria for offering one are in `docs/agents/domain.md`.

## Considered Options

- **Keep the refactor narrative in each ADR.** Rejected: git stores it, and the commit subject already names the ADR, so it was written twice while 83% of the corpus grew past the shape.
- **Cap total words instead.** Rejected: ADR-0017 legitimately carries six consolidated decisions, so a total cap forces a seventh file or drops content no other container holds. The rule caps the unit instead — one alternative per bullet — and length follows from the count of real facts.
