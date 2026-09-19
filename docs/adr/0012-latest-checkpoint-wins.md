# Latest checkpoint wins, no validation

> Amended by ADR-0013: swipe and regenerate drop the last reply's checkpoint
> at generation start; the rest of this ADR stands.

> Supersedes ADR-0010 and ADR-0011; replaces their hash, chain, and pre-user anchor mechanics.

The Continuity Checkpoint shrinks to the payload itself: a successful audit writes the merged Continuity State JSON directly into the audited reply's `extra.summaryception_continuity` — no `audited_sc_id`, no reply-text hash, no wrapper. The live read model is one descending walk: the newest assistant message carrying a payload wins, no chain walk, no hash comparison, no "strictly before the most recent user message" bound. A newer audit overwrites the payload in place, so swipe, continue, regenerate, and edit need no invalidation logic at any layer.

The trigger for this change was a live failure: an audit completed while the newest user message preceded the audited reply, so the pre-user anchor bound (ADR-0011) nulled the read model at the exact moment the injection refreshed — the slot cleared and the next generation shipped without the Continuity Block. The FNV-1a hash added a second failure mode: any external extension that rewrites `mes` in memory broke the chain and silently killed the injection while the chat file stayed internally consistent. Both mechanisms bought nothing under overwrite semantics: the stale-marker drift is already derived from assistant-message counts (ADR-0010), and a text change is exactly the case where the user wants the next audit to overwrite.

The runner keeps two non-content guards: the audited reply must still be present in the current chat at settle (reference check; a mid-flight deletion drops the write as `aborted`), and the chat-switch identity guard around the host's `saveMetadata` wait stays. Everything identity-related leaves the audit path: the sc_id backfill, the settle-time sc_id re-resolution, and the story labels, which switch from `[sc_id]` to chat-index tags. The Catch-up Window, single-call audit, JS rulebook, `classifyContinuity` JSON validation, and trigger filter are unchanged.

Consequences: existing chats with wrapped `{state, audited_sc_id, text_hash}` payloads cold-start (no migration shims per repo rules) — the payload must be the state object itself. A regenerated reply that kept its old payload blocks its own re-audit (it anchors coverage, and no unaudited exchange follows it) until the next exchange's audit re-anchors past it — accepted as the price of having no swipe semantics. The audit log keeps reporting the audited reply's `sc_id` for greppability; it is diagnostic text, not state.
