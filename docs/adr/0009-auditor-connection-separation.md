# 0009 — Auditor gets its own connection chain

The Auditor previously shared the Layer 0 summarizer connection and its fallback route. The Auditor now has its own primary and fallback connection pair (defaults inherit Layer 0 / disabled, so nothing changes until a user separates them) plus an opt-in narrative failover: when both Auditor routes fail and the checkbox is on, the full Narrative Chain (Layer 0 primary + its fallback) runs before the fail-safe freeze.

Considered option: keep sharing. Rejected — continuity freshness and narrative quality have independent availability needs, and a dedicated Auditor model must not freeze the state stale just because it alone is down.

Consequences: five uniform connection cards in two collapsible Models-tab groups; no new retry health bucket (the Auditor primary keeps the layer0-family retry behavior).
