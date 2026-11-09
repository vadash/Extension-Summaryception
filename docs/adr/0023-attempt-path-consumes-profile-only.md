# The attempt path consumes the resolved Call Profile only

The attempt path consumes the resolved Call Profile only, so `settings` leaves its interfaces: the Easy Summarizer Context cap, the CN ideograph flag, the Layer 0 size band (narrow repair ceiling, null when the family validates no size), and the output-strip patterns join the profile resolved at dispatch (ADR-0008). The guards read it; `runSingleAttempt`, `RequestRunner.run`, and `processSummarizerResponse` no longer take `settings`; and the dead repair inputs are gone because the runner folds repair into the prompt.

## Considered Options

- **Keeping `settings` beside the profile on the attempt interface** — a second policy channel re-opens the mid-run drift ADR-0008 rejected.
- **Freezing the size band as a flag plus separate bounds** — one decision split across two places is the shape this deletes.

## Consequences

Zero behaviour delta while settings are static; a mid-run edit applies to future calls only, not in-flight retries. `SummarizerCallMetadata` moves beside `resolveCallProfile` (CONTEXT.md: Call Metadata), and tests construct the frozen guard through the resolver.
