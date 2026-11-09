# Dry-run preview re-applies the outgoing seam transforms on its clone

The Dry-Run Preview re-applies the `GENERATE_AFTER_DATA` outgoing transforms to its cloned chat after microfiche expansion — the user-role rewrite, then the Guard Mask (ADR-0036) — because the host dry run early-returns before that seam, so the captured prompt is pre-transform by construction; ADR-0043's capture decision stands, but the capture reproduces prompt order, Ghosting, and prefix stability, not the outgoing transforms. The transforms run on the clone only, keeping the captured array byte-identical and never crossing the Foreground Gate (ADR-0016), and the Memory slot keeps the live skip: with memory masking off, the preview leaves the unmasked slot text alone through the same computation as the live seam.

## Considered Options

- **Trust the capture as the sent prompt** — rejected: the dry run never reaches `GENERATE_AFTER_DATA`, so the preview would show spaces where the live request sends `$$`, defeating the pre-run check.
- **Transform the captured array in place** — rejected: the read-only capture contract (ADR-0043) pins that array byte-identical, so the transform belongs to the clone.
- **A preview-only mask rule** — rejected: a second rule drifts from `maskGuardContent` and the live Memory-slot skip.
