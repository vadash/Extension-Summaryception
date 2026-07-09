# UI/UX and Summarization Route Refactor Plan

## Summary

- Unify engine-facing summarization routing while preserving existing Standard, Cache, Force, and Slop semantics.
- Clarify Standard mode as the steady-prompt, smaller-context option, not only the non-cache option.
- Keep expert engine controls available, but move low-level turn and promotion knobs out of the main Advanced view.
- Correct stale analyzer defaults so the review tooling matches current app settings.

## Key Changes

- Add a normalized route adapter for `standard-auto`, `cache-auto`, `force`, and `slop`.
- Dispatch engine commits by route commit mode:
  - `turns` for normal Layer 0 batches.
  - `turns-with-source-end` for Slop Breaker fixed cuts.
  - `atomic-partitions` for Cache Friendly flushes.
- Route UI backlog/manual preflight checks through the same adapter used by the worker.
- Leave planner-specific countability rules intact because Standard, Cache, and Slop intentionally differ around ghosted messages and protected live tails.

## UI Changes

- Reword Standard as continuous overflow summarization for steadier prompt size and quality.
- Reword Cache Friendly as a 32k live-window strategy for cached-input providers.
- Keep primary tuning focused on source size, trigger size, summary size, live chat window, and memory size.
- Move min/max turns and layer promotion knobs into collapsed Expert Tuning.

## Test Plan

- Add adapter tests for Standard, Cache, Force, and Slop normalized plans.
- Update worker and UI tests for route-based dispatch and preflight.
- Run `npm test` and fix regressions.

## Assumptions

- Do not remove existing expert knobs or persisted settings.
- Preserve cache readiness, protected tail, Slop target selection, ghosting, and promotion ordering.
- Do not run ESLint or Prettier manually; project hooks own formatting.
