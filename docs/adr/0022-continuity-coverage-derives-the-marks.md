# Continuity Coverage derives the marks; the marker is a DOM adapter

The Continuity Mark model lives in `src/core/continuity-coverage.js`: `deriveContinuityMarks` derives the marks beside the coverage anchor, and `src/entry/continuity-marker.js` keeps only the DOM toggle. The newest-payload-wins walk now rides `findLiveCheckpoint(messages, -1)`, so the one deliberate divergence (ADR-0017) becomes one explicit argument.

## Considered Options

- **A marks field on the coverage result** — a DOM toggle would hold the whole coverage interface.
- **Exporting only the live anchor** — payload-presence knowledge stays split across the seam.
