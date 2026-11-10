---
status: superseded by ADR-0051
---

# Microfiche images every full page and ships it image-only

Every full page of the Raw Seal becomes a Frozen Page with only the growing remainder shipping as a text tail, and page breaks fall on a `.` or a newline, hard-cutting only when neither exists so one message may span two pages (ADR-0038, ADR-0040). The 0.75 Fill Gate governs only the last partial page, where underfill or a page that does not fit the raw bucket sets `overCap` and runs a memory update instead of adding an image (ADR-0039, ADR-0046). Expansion and the live prompt send each Frozen Page image-only — the sealed text it covers is stripped, never repeated — so a page bills image tokens plus the tail text, the Dry-Run Preview shows that same image-only payload, and the View Model for the status bars renders image spend as its own colored segment on both Frozen Raw Images and memory pages, with the keep-raw knob still defaulting to zero (ADR-0042, ADR-0045).

## Considered Options

- **Send page text beside the image as a fallback.** Rejected: the provider bills that text beside the frame, so the image saves nothing.
- **Gate every page at 0.75.** Rejected: a full page pays for itself, and gating it leaves covered text shipping as text.
- **Bill the status bars from live text.** Rejected: the bars hide the image saving and the trigger fires on cost the prompt never incurs.
