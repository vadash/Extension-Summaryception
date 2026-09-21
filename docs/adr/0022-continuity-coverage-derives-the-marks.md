# Continuity Coverage derives the marks; the marker is a DOM adapter

The Continuity Mark read model lives in `src/core/continuity-coverage.js`: `deriveContinuityMarks(chat)` returns `{ markedIndices, liveIndex }` beside the coverage anchor, and `src/entry/continuity-marker.js` keeps only the DOM toggle. The newest-payload-wins walk was implemented twice — coverage's back-to-front `findLiveCheckpoint` and the marker's forward walk in entry — with the sync between them existing only as a doc comment and two test files pinning the same rule twice, so the mark derivation now rides `findLiveCheckpoint(messages, -1)`: the one deliberate divergence, the marker reading the chat view while the coverage anchor excludes the Reroll Tail (ADR-0017), becomes one explicit argument instead of a second walk.

## Considered Options

- **A marks field on the coverage result** — a DOM toggle would then hold the whole coverage interface, and the prompt-view/chat-view duality would become an options fact on a result that otherwise means the prompt view.
- **Exporting only the live anchor** — the payload-presence knowledge would stay split across the seam, which is the weaker form of the same defect.

## Consequences

Zero behaviour delta: the same `markedIndices`, `liveIndex`, and `turnCount` on every path, and the Continuity Block reads coverage rather than marks so injected text cannot move. `deriveTurnCount` is restored in `src/core/continuity-state.js` as the authority coverage consumes, and one `isAssistantMessage` predicate serves every chat walk.
