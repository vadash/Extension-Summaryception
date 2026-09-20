# 0023 — The attempt path consumes the resolved Call Profile only

`src/core/call-profile.js` resolves the last unfrozen policy facts at dispatch, and `settings` leaves the attempt path's interfaces. `CallProfilePolicy` gains the Easy Summarizer Context cap (`easyContextLimit`, null outside Easy mode or for a malformed cap), the CN ideograph flag (`stripChineseIdeographs`), and the Layer 0 size band (`sizeGuard`: target, min, max, and the narrow repair ceiling — null when the family validates no size). `checkEasyContextGuard`, `applyChineseOutputPolicy`, and `validateLayer0OutputSize` read the resolved policy; `runSingleAttempt`, `RequestRunner.run`, and `processSummarizerResponse` no longer take `settings`, and the attempt's dead `layer0Repair`/`repairFeedback` inputs are deleted — the runner folds repair into the prompt before dispatch.

**ADR-0008 promised this freeze; the attempt layer never finished it.** ADR-0008 resolved the Call Profile once at dispatch, but three per-attempt re-reads kept the hole: the Easy guard read `uiMode` and `advancedModelContext` from live settings on every attempt, the CN policy re-read `stripChineseIdeographs` per attempt, and the Layer 0 size guard took its flag from the profile but its bounds, ceiling, and target from live settings. `getEffectiveSettings` returns the live object, so an edit made while a call is in flight changed that call's policy between retries — the exact mid-run drift ADR-0008's rejected behaviour describes.

**The prompt hint follows the guard.** `appendLayer0PromptConstraints`' Layer 0 budget hint now reads the same frozen band the attempt enforces (`policy.sizeGuard.target`). Promotion constraints keep their dispatch-time settings read: a prompt is built once per dispatch and is immutable after, so no per-attempt drift exists there.

**The resolver input has a name.** `SummarizerCallMetadata` — the resolver's input: call category plus the provenance the dispatch constructors build — moves from the metering module (src/core/summarizer-usage.js) beside `resolveCallProfile`, and CONTEXT.md names it Call Metadata. The request path still never reads `kind`.

Rejected:

- Keeping `settings` beside the profile on the attempt interface: a second policy channel re-opens the drift.
- Freezing the size band as a flag plus separate bounds: one decision split across two places is the shape this ADR deletes.
- Moving the promotion prompt target into the policy: the promotion prompt is dispatch-built and immutable; its validation reads settings at its own dispatch.

Out of scope, deliberately: the dispatch-time settings reads that build prompts (the prompt is immutable after dispatch), and any change to the Connection Chain's route resolution.

Zero behavior delta while settings are static: same guards trigger, same numbers, same errors, same logs. The intended delta: a mid-run settings edit applies to future calls only, never to an in-flight call's retries.

Consequences: tests construct the frozen guard through `resolveCallProfile`; the attempt-layer settings plumbing and the dead repair passthroughs are gone; ADR-0008's freeze is finally total.
