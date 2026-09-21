---
status: superseded by ADR-0017
---

# Continuity Checkpoint in message extra, not chat metadata

The Continuity State moved out of chat metadata into per-message checkpoints, read as a chain walk with sc_id resolution and an FNV-1a reply-text hash. ADR-0017 keeps message-extra storage but the payload shrinks to the state itself and the read model is latest-payload-wins, because external `mes` rewrites broke the chain and silently killed injections.
