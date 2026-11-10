# Microfiche renders snapcompact bitmap glyphs through the browser canvas seam

Microfiche glyphs come from the snapcompact public-domain bitmap fonts parsed at load and blitted through the page-source canvas seam; PNG bytes may differ from snapcompact's encoder, but glyph bits, wide-cell layout, and coverage stay the same. The `.node` binary cannot load in a browser and WASM would add a first native toolchain, so the port is JS through the current canvas seam with no new pipeline; the payload is BDF/hex only with `silver` dropped and uncovered glyphs folding to `?` until the CJK follow-up.

## Considered Options

- **Compile the Rust renderer to WASM** — rejected: first native build pipeline and binary in a browser-only extension for identical glyphs.
- **Keep system-monospace fillText** — rejected: per-machine fallback fonts make pixels non-deterministic, and wide glyphs cannot share the grid math.
