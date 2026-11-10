---
status: superseded by ADR-0049
---

# Microfiche markers are emitted by the injection writer

The memory injection writer owns inserting `formatMicroficheMarker` page tags into the prompt slot text for image-backed spans, gated per region by the memory-images and frozen-raw-images toggles: policy stays pure plan computation (ADR-0039), the page source stays seal-and-render cache (ADR-0038, ADR-0040), and the single text-assembly point owns the wire shape the expansion seam later swaps to `image_url` parts, so marker placement changes in exactly one module when prefix stability demands it.

## Considered Options

- **Emit markers in policy** — rejected: plan computation would own slot text shape alongside fill and bucket gating.
- **Emit markers at expansion time** — rejected: the send-time seam would invent content instead of swapping tags the slot already carries.
