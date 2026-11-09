# Auditor gets its own connection, with one settled pass

The Auditor has its own primary route (default: inherit Layer 0) and runs exactly one settled pass — no auditor fallback route, no narrative failover, no LLM repair call. The removed `auditorFallback*` keys and narrative-failover toggle are dead stored values, not migrated; an inherited Auditor still runs the Narrative Chain as a Layer 0 call.

Considered options: keep the two-hop chain and failover toggle; add an LLM repair pass. Rejected — the audit self-heals within a turn or two (ADR-0017); both added latency, cost, and settings surface.

Consequences: one connection card for the Auditor; `recovery_tier` in the audit log is the only Parse Recovery trace.
