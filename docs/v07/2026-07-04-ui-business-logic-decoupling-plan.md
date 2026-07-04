# UI Business Logic Decoupling Plan

## Summary

Move snippet mutation and maintenance workflows out of entry-layer UI files. Entry modules should read DOM state, show confirmations/toasts, manage button state, and refresh views. Feature modules should own storage mutation, summarizer calls, ghosting repair, persistence, and injection updates.

## Key Changes

- Add `src/features/snippet-manager.js` for snippet edit, delete, and regeneration workflows.
- Add `src/features/maintenance.js` for orphaned hidden-message repair.
- Keep snippet browser rendering and DOM event binding in `src/entry/ui.js`.
- Keep repair progress toast ownership in `src/entry/ui-events.js`.
- Return compact status objects from feature functions so entry handlers can decide user-facing feedback.

## Test Plan

- Add feature tests for snippet edit, delete, regeneration success/failure, busy state, unsupported snippets, and empty source turns.
- Add maintenance tests for orphan detection, skipped messages, slash-command failures, repair persistence, and no-op scans.
- Use `npm test` only for verification.

## Assumptions

- Public UI behavior, settings IDs, metadata shape, and summarization semantics stay unchanged.
- Feature modules must not import from `src/entry/*`.
- User-facing effects stay entry-owned.
