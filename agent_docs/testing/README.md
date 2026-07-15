# Testing

- Framework and discovery live in `vitest.config.js`; global setup lives in `tests/setup.js`.
- Use `tests/test-helpers.js` fixtures instead of inline SillyTavern, toastr, browser-runtime, or jQuery stubs.
- `src/foundation/context.js` and `src/foundation/logger.js` are globally mocked. Add every new context-facade export to `tests/setup.js` in same change.
- Override foundation mocks through `globalThis.summaryceptionFoundationMocks`. Use explicit `vi.unmock()` when testing real foundation modules.
- Test each `src/core/connection-*.js` source independently.
- Context tests must cover missing/undefined optional SillyTavern APIs and match defensive facade behavior.
- Run focused Vitest files while iterating when useful; run `npm test` before handing off behavior changes.
- Never run ESLint or Prettier manually; Husky owns both.
