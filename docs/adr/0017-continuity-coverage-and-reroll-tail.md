# Continuity Checkpoint: latest payload wins, read through one Continuity Coverage model

A successful audit writes the merged Continuity State JSON into the audited reply's `extra.summaryception_continuity` — the payload is the state itself. The engine reads the chat through one model, Continuity Coverage: the live checkpoint is the newest assistant reply carrying a payload, carrying the un-audited replies, the Catch-up Window, the Turn Count, the staleness verdict, and the Continuity Block's placement — so a newer audit overwrites in place and swipe, continue, regenerate, and edit need no invalidation. The marks ride `findLiveCheckpoint(messages, -1)` beside the anchor with one explicit chat-view argument, and `src/entry/continuity-marker.js` keeps only the DOM toggle.

## Considered Options

- **A chain walk with a reply-text hash and anchor bound (ADR-0010, ADR-0011)** — the bound nulled the read model at refresh; the hash broke on in-memory rewrites.
- **Delta chains over checkpoints** — replay logic, and one corrupt delta poisons the chain.
- **Auditing at swipe time (ADR-0007)** — burns calls on drafts the user discards.
- **Retrying a malformed audit with repair feedback (ADR-0011)** — doubles cost while the Catch-up Window already re-reads them.
- **The shared chat-metadata slot (pre-0010)** — deleting an Exchange older than the anchor contaminated it permanently.

Wrapped payloads cold-start with no migration shims. Audits fire on settled replies only, so discarded drafts never burn a call and the next audit re-covers them. Payloads accumulate ~1–3 KB per Exchange, unbounded.
