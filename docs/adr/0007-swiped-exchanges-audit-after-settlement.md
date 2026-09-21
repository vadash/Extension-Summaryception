---
status: superseded by ADR-0017
---

# Swiped Exchanges audit after settlement, not at swipe time

Swipe, continue, and regenerate never dispatched the Auditor; coverage rewound one Exchange (`rewindContinuityAnchor`) with a `continuityRevert` snapshot restore. ADR-0017 restates the surviving rule — audits fire on settled replies only — and the rewind bookkeeping is gone: invalidation is overwrite plus the generation-start drop.
