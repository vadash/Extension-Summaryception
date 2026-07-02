Implement a focused behavior-preserving refactor for the high/medium maintainability items only.

1. Consolidate batch summarization in `src/core/summarizer.js`
   - Extract the duplicated common flow from `summarizeOneBatch()` and `summarizeOneBatchFromTurns()` into a private helper, likely `summarizeBatchFromTurns(visibleTurns, options)`.
   - Preserve current differences through options, such as toast behavior and exception handling.
   - Keep exported function names unchanged so event/UI callers do not need broader changes.

2. Centralize chat state persistence and refresh sequencing
   - Add a small shared helper module or service functions for the repeated sequence: `saveChatStore()`, optional `ctx.saveChat()`, `updateInjection()`, and optional `updateUI()`.
   - Use it in summarizer and UI flows that currently repeat this sequence.
   - Preserve existing ordering where it is behaviorally relevant.

3. Add shared memory clear workflow
   - Extract the duplicated clear-memory logic from `src/entry/ui.js` and `src/entry/commands.js` into one function, likely in a new service module such as `src/features/memory.js` or `src/features/actions.js`.
   - The helper will unghost all messages, reset layers, `summarizedUpTo`, and `ghostedIndices`, persist metadata, refresh injection, and optionally refresh UI.
   - Wire both the `#sc_clear_memory` click handler and `/sc-clear` slash command to this helper.

4. Refactor connection transport helpers in `src/core/connectionutil.js`
   - Extract small helpers for proxy/direct fetch fallback, reading response error text, local endpoint detection, and OpenAI-compatible endpoint normalization.
   - Keep provider-specific request bodies and response parsing in their current functions.
   - Preserve existing error messages and retryability as much as possible.

5. Verification
   - Run the package lint/test scripts where possible, plus `tsc --noEmit` for JS type checking.
   - Manually inspect imports/exports and run grep checks to confirm the duplicated clear-memory and summarization code paths are removed.
   - Report any verification limits caused by SillyTavern/browser-only globals.

Out of scope for this session:
- Full `src/entry/ui.js` module split, because that is a larger, higher-risk restructure.
- Low-priority version/comment cleanup unless it falls out naturally from touched code.
