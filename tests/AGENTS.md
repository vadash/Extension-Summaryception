# Testing Guidelines

We use Vitest for our testing framework. 

## Testing Rules
- Use `tests/test-helpers.js` fixtures over inline SillyTavern/toastr/jQuery stubs.
- Test each connection source independently when connection code (`src/core/connection*.js`) changes.
- Verify backlog detection, foreground-generation freeze, ghosting, and layer promotion logic with large mock chats.
- For manual UI verification, use `debugMode` or `traceMode` within SillyTavern.
- Ensure any tests touching the SillyTavern context stub handle missing/undefined API methods gracefully, mimicking the defensive facade in `src/foundation/context.js`.