---
status: superseded by ADR-0017
---

# Latest checkpoint wins, no validation

The checkpoint shrank to the bare Continuity State payload in `extra.summaryception_continuity` and the chain read model became latest-payload-wins, after the pre-user anchor bound and the FNV-1a hash caused live injection failures. ADR-0017 restates this together with ADR-0013's generation-start drop.
