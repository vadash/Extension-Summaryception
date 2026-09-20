# Structured run outcomes cross the core seam; entry renders all notices

> Superseded by ADR-0019 (2026-09-20). Decided that core modules return a
> structured Run Outcome, that core receives notices through one explicit notify
> adapter created at the composition root, and that every user-facing toast
> string lives in entry. ADR-0019 restates that decision whole and extends it
> with the Manual Run as a fifth run level, the `partial` status, and the manual
> run's display policy.
