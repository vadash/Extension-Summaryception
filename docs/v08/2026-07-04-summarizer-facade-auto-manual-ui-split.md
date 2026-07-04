# Summarizer Facade Auto Manual UI Split

## Summary

`src/core/summarizer.js` is reduced to the runtime facade around `SummarizerQueue`. Automatic worker orchestration, manual foreground loops, prompt-guard recovery, and UI presentation now live in focused modules.

## Implementation

- `src/core/summarizer-auto.js` owns automatic layer-0 overflow processing, promotion passes, backlog dismissal state, and worker yielding.
- `src/core/summarizer-manual.js` owns Force Summarize and Slop Breaker loops through a shared cancelable executor.
- `src/core/summarizer-commit.js` owns stale foreground-freeze recovery and the shared prompt-work stop check.
- `src/entry/ui-dialogs.js` owns manual progress toasts, outcome toasts, backlog notices, and modal dialogs.
- `src/core/summarizer.js` preserves the public facade API used by entry, feature, and test modules.

## Interfaces

- Manual runners accept optional `{ signal, onStart, onProgress }` options.
- Manual runners return `ManualRunOutcome` with `cancelled`, `blocked`, `completed`, `failed`, `totalBatches`, `fullyCommitted`, `shouldReload`, and `failureLimitReached`.
- Automatic backlog UI is registered with `setSummarizerNotifiers({ showAutoBacklogNotice })`.

## Verification

- Behavior coverage is in `tests/summarizer-worker.test.js`.
- The allowed verification command for this change is `npm test`.

## Non-Goals

- This change does not alter batching, promotion, ghosting, injection, connection routing, or persistence semantics.
- Existing `toastr` usage in other core modules is intentionally out of scope.
