# The attempt path consumes the resolved Call Profile only

`src/core/call-profile.js` resolves the last unfrozen policy facts at dispatch — the Easy Summarizer Context cap (`easyContextLimit`), the CN ideograph flag (`stripChineseIdeographs`), and the Layer 0 size band (`sizeGuard`: target, min, max, and the narrow repair ceiling, null when the family validates no size) — so `settings` leaves the attempt path's interfaces. `checkEasyContextGuard`, `applyChineseOutputPolicy`, and `validateLayer0OutputSize` read that resolved policy, `runSingleAttempt`, `RequestRunner.run`, and `processSummarizerResponse` no longer take `settings`, and the attempt's dead `layer0Repair`/`repairFeedback` inputs are gone because the runner folds repair into the prompt before dispatch.

## Considered Options

- **Keeping `settings` beside the profile on the attempt interface** — a second policy channel re-opens exactly the mid-run drift ADR-0008 rejected, where an edit made while a call is in flight changed that call's policy between retries.
- **Freezing the size band as a flag plus separate bounds** — one decision split across two places is the shape this deletes.
- **Moving the promotion prompt target into the policy** — the promotion prompt is dispatch-built and immutable after, so its validation reads settings at its own dispatch.

## Consequences

Zero behaviour delta while settings are static: the same guards trigger with the same numbers, errors, and logs. The intended delta is that a mid-run settings edit applies to future calls only, never to an in-flight call's retries. Tests construct the frozen guard through `resolveCallProfile`, `SummarizerCallMetadata` — the resolver's input, the call category plus the dispatch provenance — moves beside `resolveCallProfile`, and `CONTEXT.md` names it Call Metadata.
