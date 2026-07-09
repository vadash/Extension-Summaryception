# Testing Guidelines

We use Vitest for our testing framework.

## Rules

- Use `tests/test-helpers.js` fixtures over inline SillyTavern/toastr/jQuery stubs.
- `src/foundation/context.js` and `src/foundation/logger.js` are globally mocked by `tests/setup.js`.
- Override mocks via `globalThis.summaryceptionFoundationMocks`, and explicitly `vi.unmock` them in tests when you need the real modules.
- Test each connection source independently in `src/core/connection*.js`.
- Ensure tests touching the SillyTavern context stub handle missing/undefined API methods gracefully, mimicking the defensive facade.
