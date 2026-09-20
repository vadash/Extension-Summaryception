# Latest checkpoint wins, no validation

> Superseded by ADR-0017 (2026-09-20) via ADR-0014, which restates this decision together with
> ADR-0013's generation-start drop. Shrank the checkpoint to the bare Continuity
> State payload in `extra.summaryception_continuity` and replaced the chain read
> model with latest-payload-wins, after the pre-user anchor bound and the FNV-1a
> hash caused live injection failures.
