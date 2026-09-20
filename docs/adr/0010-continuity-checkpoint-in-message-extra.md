# Continuity Checkpoint in message extra, not chat metadata

> Superseded by ADR-0017 (2026-09-20) via ADR-0014. Moved the Continuity State out of chat
> metadata into per-message checkpoints read as a chain walk with sc_id resolution
> and an FNV-1a reply-text hash; external `mes` rewrites broke the chain and
> silently killed injections. ADR-0014 keeps the message-extra storage but the
> payload shrinks to the state itself and the read model is latest-payload-wins;
> staleness stays derived, not stored.
