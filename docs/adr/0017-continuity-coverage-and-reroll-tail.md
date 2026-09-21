# Continuity Checkpoint: latest payload wins, read through one Continuity Coverage model

A successful audit writes the merged Continuity State JSON into the audited reply's `extra.summaryception_continuity` — the payload is the state itself, with no wrapper, `audited_sc_id`, or reply-text hash. Every chat fact the Continuity Engine needs comes from one read model, Continuity Coverage (`deriveContinuityCoverage`): the live checkpoint is the newest assistant reply carrying a payload, and the same value carries the un-audited replies after it, the Catch-up Window, the Turn Count, the staleness verdict, and the Continuity Block's prompt placement — so a newer audit overwrites the payload in place and swipe, continue, regenerate, and edit need no invalidation logic at any layer. Because the host excludes a rerolled reply from the prompt chat and removes it only after our generation-start hook, coverage drops the replaced reply's checkpoint at generation start, tracks the reroll in flight, and places the block one message past the last covered reply as the prompt will see it, while the stale marker keeps reading the chat view. Supersedes ADR-0014, which superseded ADR-0007, ADR-0010, ADR-0011, ADR-0012, and ADR-0013.

## Considered Options

- **A chain walk with an FNV-1a reply-text hash and a pre-user anchor bound (ADR-0010, ADR-0011)** — the bound nulled the read model at the exact moment the injection refreshed, clearing the slot so the next generation shipped without the Continuity Block, and the hash broke whenever an extension rewrote `mes` in memory while the chat file stayed internally consistent.
- **Delta chains over checkpoints** — replay logic, and one corrupt delta poisons the chain.
- **Auditing at swipe time (ADR-0007)** — burns calls on drafts the user discards.
- **Retrying a malformed audit with repair feedback (ADR-0011)** — doubles the cost of every malformed draft while the Catch-up Window already guarantees the next audit re-reads the same Exchanges.
- **The shared chat-metadata slot (pre-0010)** — deleting an Exchange older than the anchor contaminated the state permanently, because no rewind fired for an anchor that still resolved.

## Consequences

Chats holding wrapped `{ state, audited_sc_id, text_hash }` payloads cold-start, since the payload must be the state object itself; there are no migration shims. Every settled audit leaves a payload on its reply and older payloads stay as the reroll-drop fallback, so chat files grow by the state size (~1–3 KB) per Exchange, unbounded. Audits always run to completion and attach at settle — the host's `generateRaw` takes no AbortSignal — and a reply deleted before settle drops the write as `aborted`. Story labels use chat-index tags, while the audit log keeps reporting the reply's `sc_id` for greppability as diagnostic text, not state.
