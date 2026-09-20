# No swipes, pre-user anchor bound, single-call audit

> Superseded by ADR-0017 (2026-09-20) via ADR-0014. Removed swipe semantics from the trigger
> set, made the audit a single LLM call, and bounded the read model with a
> pre-user anchor. The no-swipe trigger filter and single-call audit stand
> (restated in ADR-0014); the pre-user anchor bound was removed after a live
> failure nulled the read model exactly when the injection refreshed —
> latest-payload-wins replaced it.
