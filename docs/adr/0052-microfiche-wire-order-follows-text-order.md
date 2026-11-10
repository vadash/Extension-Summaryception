# Microfiche wire order follows text order

The Dry-Run Preview showed memory-slot raw images that read as randomly injected, because their markers sat apart from the chat text they replaced; the decision is that the wire order stays chronological: host preset blocks stay text, the memory slot carries memory pages then raw pages in seal order, and raw chat text follows in chat order, while the expansion seam swaps each marker in place and never moves a message, with the Memory Injection writer owning the markers and the Microfiche page source sealing each region's pages. That order keeps the prompt prefix stable across generations (ADR-0038, ADR-0040), preserves the image-only flow where a resolved page ships its frame and no page text (ADR-0051), and makes the image form read as the text form it replaces.

## Considered Options

- **Send one separate image message per region** — rejected: extra messages shift every later prompt block, breaking provider prefix-cache stability.
- **Place the raw images among the host preset blocks** — rejected: preset blocks are host text, and raw pages there separate the images from the raw chat text they replace, so the image form stops matching the text form.
