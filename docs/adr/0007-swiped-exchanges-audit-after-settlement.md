# Swiped Exchanges audit after settlement, not at swipe time

> Superseded by ADR-0014 (2026-09-20). Decided that swipe, continue, and regenerate
> never dispatch the Auditor; coverage rewound one Exchange instead
> (`rewindContinuityAnchor`) with a `continuityRevert` snapshot restore. The
> audits-fire-on-settled-replies-only rule is restated in ADR-0014; the rewind
> bookkeeping is gone — invalidation is overwrite plus the generation-start drop.
