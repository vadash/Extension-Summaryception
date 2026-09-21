---
status: superseded by ADR-0019
---

# Structured run outcomes cross the core seam; entry renders all notices

Core modules returned a structured Run Outcome and received notices through one explicit notify adapter created at the composition root; every user-facing toast string lived in entry. ADR-0019 restates this whole and extends it with the Manual Run as a fifth run level, the `partial` status, and the manual run's display policy.
