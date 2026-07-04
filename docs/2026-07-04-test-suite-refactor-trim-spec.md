# Test Suite Refactor And Trim Spec

## Summary

Refactor tests without reducing meaningful behavioral coverage. Optimize for fewer test lines and more robust shared fixtures rather than deleting scenarios.

Baseline before refactor:

- 28 Vitest spec files, 193 tests
- 4,025 spec lines excluding `tests/test-helpers.js`
- 4,112 total test lines including helpers
- `npm test` passing

Target:

- At least 10% spec-line reduction
- Preserve behavior-focused scenarios
- Keep runtime globals and SillyTavern stubs centralized

## Implementation

- Expand `tests/test-helpers.js` with shared fixtures for SillyTavern contexts, browser globals, summary settings, summary stores, long chats, token counting, and deferred promises.
- Refactor duplicate-heavy specs first: worker, batch, ghosting, snippet manager, context facade, state, chatutils, queue, and OpenAI streaming tests.
- Prefer table-driven tests for repeated facade/normalization/streaming cases where assertions remain clear.
- Keep side-effect assertions local for ghosting, metadata mutation, injection refresh, abort behavior, and summarizer commits.

## Verification

- Run `npm test`.
- Confirm behavior remains covered and the suite stays green.
- Compare before/after line counts for both spec files and total test files.

