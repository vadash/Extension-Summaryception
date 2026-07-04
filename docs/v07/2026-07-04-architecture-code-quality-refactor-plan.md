# Architecture And Code Quality Refactor Plan

## Summary

This refactor is intentionally split into three independently shippable slices. The UI, worker, and type-system changes each touch different failure modes and test surfaces, so they should not be bundled into one implementation pass.

Recommended order:

1. Fine-grained snippet browser rendering.
2. Summarizer worker queue/state machine.
3. Stricter JSDoc and global type schemas.

Keep the no-build ES module architecture, stable settings IDs, jQuery live-DOM rule, and current public runtime behavior.

## Slice 1: Fine-Grained UI Rendering

Goal: preserve scroll position, focus, and in-progress snippet edits when the Summaryception UI refreshes.

Implementation requirements:

- Replace `#sc_snippet_browser.html(...)` full replacement with a keyed jQuery renderer.
- Keep `settings.html` IDs and public controls unchanged.
- Use jQuery for all live DOM access and mutation.
- Render snippet layers in the existing order: deepest layer first, Layer 0 last.
- Use stable per-render keys based on layer index and snippet index.
- Reuse existing `.sc-browser-layer` and `.sc-snippet` elements when their keys are still present.
- Preserve `#sc_snippet_browser.scrollTop()` across refreshes.
- If a row contains a focused `.sc-snippet-edit`, do not replace that row during refresh.
- Use delegated event handlers on `#sc_snippet_browser` for edit, regenerate, and delete actions.
- Fetch the current chat store inside delegated handlers so handlers do not close over stale store objects.
- Keep the existing edit behavior:
  - Click snippet text to edit.
  - Enter saves when Shift is not held.
  - Shift+Enter inserts a newline.
  - Escape cancels the edit.
  - Blur saves non-empty changed text.
- Keep the existing regenerate and delete behavior, including Layer 0 unghosting after deletion.

Test requirements:

- Unit-test snippet browser view-model construction for empty stores, layer ordering, metadata text, redo eligibility, and row keys.
- Continue using `npm test` only for verification.
- Manual SillyTavern checks remain recommended for scroll and focus preservation, but are not run by the agent.

## Slice 2: SummarizerQueue State Machine

Goal: move background worker state out of module-level globals and into a testable queue object.

Implementation requirements:

- Add `src/core/summarizer-queue.js`.
- Export `class SummarizerQueue`.
- Move `workerStatus`, `workerPromise`, and `manualSummarizing` into the queue instance.
- Preserve existing exports from `src/core/summarizer.js`:
  - `requestSummarization`
  - `maybeSummarizeTurns`
  - `getIsSummarizing`
  - `setSummarizing`
  - `abortSummarization`
  - `runCatchup`
- Keep `src/core/summarizer.js` as the runtime facade around one default queue instance.
- Track phases with these exact labels:
  - `idle`
  - `layer0`
  - `promoting`
  - `yielding`
  - `paused`
- Keep coalescing semantics:
  - A request while the worker is running sets dirty state and returns the active worker promise.
  - The worker drains until no pending or dirty work remains.
  - Failed batches stop the current drain to avoid a tight retry loop.
- Keep prompt mutation guard behavior:
  - Stop automatic work while foreground generation or queued prompt effects are active.
  - Requeue after foreground generation ends.
- Inject dependencies into `SummarizerQueue` so queue behavior can be unit-tested without `vi.resetModules()`.
  - Required dependencies: drain-one-cycle callback, abort callback, UI refresh callback, usage wrapper, and optional logger.
- Leave catch-up behavior compatible in the first queue slice; move it into the queue only if this does not expand the public surface.

Test requirements:

- Add direct `SummarizerQueue` unit tests for:
  - first request starts a drain
  - second request during a drain coalesces into the same promise
  - dirty state causes another cycle
  - failed cycle stops the drain
  - abort clears pending and manual busy state
  - manual busy state affects `getIsSummarizing`
  - phase transitions through `layer0`, `promoting`, `yielding`, and `idle`
- Keep existing worker integration tests to verify real summarizer behavior.
- Use `npm test` only.

## Slice 3: Stricter JSDoc And Global Schemas

Goal: replace broad records with concrete structures where the runtime shape is known.

Implementation requirements:

- Update `types/globals.d.ts` with concrete interfaces for:
  - `ChatMessageExtra`
  - `ChatMessage`
  - `SummaryceptionSnippet`
  - `SummaryceptionStore`
  - `ExtensionSettings`
  - `GenerateRawMessage`
  - `GenerateRawOptions`
  - `OpenAIChatCompletionChunk`
  - `OpenAIChatCompletionDelta`
  - `OpenAIChatCompletionChoice`
  - `ConnectionProfileMessage`
  - `ConnectionProfileResponse`
- Align `ExtensionSettings` with `defaultSettings`; remove stale settings names that are no longer used.
- Type `extra.sc_ghosted` as optional boolean.
- Type Layer 0 snippets with optional `[number, number]` `turnRange`.
- Type promoted and merged snippet metadata:
  - `promoted`
  - `seedFromLayer`
  - `fromLayer`
  - `mergedCount`
  - `timestamp`
  - `regenerated`
- Update JSDoc in these modules to use the new names where useful:
  - `src/foundation/state.js`
  - `src/foundation/context.js`
  - `src/core/connection-openai.js`
  - `src/core/connection-profile.js`
  - `src/core/connection-default.js`
- Keep permissive index signatures only where SillyTavern or provider APIs are genuinely open-ended.

Test requirements:

- Extend OpenAI connection tests to cover typed chunk parsing behavior that is already supported.
- Extend profile connection tests if response-shape parsing is exported or otherwise reachable.
- Use `npm test` only.

## Non-Goals

- Do not change summarization semantics.
- Do not change ghosting, prompt injection, or connection routing behavior.
- Do not introduce a bundler, framework, Web Components, or build step.
- Do not change settings control IDs.
- Do not perform repository-wide formatting outside files touched by these slices.

