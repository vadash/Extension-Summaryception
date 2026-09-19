# Regenerated replies drop their checkpoint at generation start

> Amends ADR-0012: the newest-payload-wins read model stands, but the live
> failure it accepted for regeneration is fixed at the generation seam. The
> payload-in-extra storage, no hash, no chain walk, and the trigger filter
> are unchanged.

ADR-0012 accepted that a regenerated reply keeps its pre-regeneration
payload: ST keeps the last message — with its `extra` — in the chat during a
swipe or regenerate, so the read model saw the discarded draft's own state,
and the regenerated prompt shipped a Continuity Block describing the exact
answer being replaced. The kept payload also anchored coverage, blocking the
reply's own re-audit until the next exchange.

Fix: when a host generation starts with type `swipe` or `regenerate`
(`GENERATION_STARTED` args), the live checkpoint is dropped when it sits on
the last assistant message (`discardRegeneratedCheckpoint`,
src/core/continuity-runner.js) and the injection slot refreshes before the
prompt freeze locks the slot content. The read model falls back to the prior
checkpoint — the state as of before the rerolled answer — and the regenerated
reply becomes unaudited, so the next settled audit re-covers it through the
Catch-up Window. The drop is in-memory only: ST persists the chat when the
regenerated reply settles.

Not covered: `continue` keeps its payload (the message stays in the prompt,
so shipping it mid-generation is consistent); a payload left by an external
edit is still overwritten by the next audit. An audit settling exactly while
a reroll of its own target starts can re-attach the stale payload — the next
reroll drops it again.
