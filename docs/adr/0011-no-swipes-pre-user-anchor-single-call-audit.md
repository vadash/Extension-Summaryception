---
status: superseded by ADR-0017
---

# No swipes, pre-user anchor bound, single-call audit

The trigger set dropped swipe semantics, the audit became one LLM call, and the read model was bounded by a pre-user anchor. ADR-0017 keeps the no-swipe trigger filter and the single-call audit; the pre-user anchor bound was removed after a live failure nulled the read model exactly when the injection refreshed.
