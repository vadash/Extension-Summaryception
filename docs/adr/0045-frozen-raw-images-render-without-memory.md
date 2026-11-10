---
status: superseded by ADR-0051
---

# Frozen Raw Images render without memory

Frozen raw imaging is its own Microfiche region: `microficheFrozenRawImages` pages the Raw Seal — the oldest-first raw slice spanning the queued span and verbatim window — into images even when `layers` is empty, while `microficheMemoryImages` gates memory pages alone. Both regions reuse the same 0.75 Fill Gate and raw bucket: a page images only when it fills three quarters of a frame, and billed(k) is the candidate plus k times frame-minus-page, counting kept images, shipped tail, and the other region's spend (ADR-0046); when the next full image would not fit the engine runs a memory update instead of adding that image. Billing and the engine trigger read the page-source sealed plan, never a fresh re-slice. Memory pages keep `[summaryception-microfiche page=N]`; frozen raw pages carry the region in the marker, `[summaryception-microfiche page=N:raw]`, so the two sealed page lists never collide, and the Raw Seal still clears only on the next Mutation Epoch (ADR-0040).

## Considered Options

- **Gate raw imaging behind memory pages** — rejected: a fresh chat has no snippets yet, and the raw window is exactly the context worth imaging.
- **One combined sealed page list** — rejected: raw indexes would shift with the memory page count or a region toggle, so a raw marker could resolve to a memory page; region tags keep each list index-stable.
- **Image every raw page regardless of fill or bucket** — rejected: an underfilled or over-budget frame spends a full image cost for little coverage; that page stays text and the engine runs a memory update instead.
- **Re-slice the raw chat each generation** — rejected: re-hashing page keys breaks provider prefix-cache stability (ADR-0040).
