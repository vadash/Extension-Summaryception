# Source Guidelines

## Code Style
- **Language:** Vanilla JS (ES2022+ modules).
- **Naming:** `camelCase` for variables/functions, `SCREAMING_SNAKE_CASE` for constants, `PascalCase` for classes.
- **Functions:** Prefer `const fn = () => {}` inline, and `function name() {}` for hoisted helpers. Keep functions under 80 lines and complexity under 15.
- **Documentation:** Add JSDoc to exports and useful internal transaction/worker types.
- **Logging:** Prefix console output with `[Summaryception]` via the `LOG_PREFIX` constant.
- **Log Levels:** Use `info` for quiet lifecycle milestones, `debug` for diagnostic decisions, `trace` for hot-path details, and `warn`/`error` for always-visible failures. Keep full LLM input dumps behind `promptInputLogMode`; `promptOutputLogMode` logs cleaned summaries/errors only and must not expose raw provider output.

## DOM Manipulation
- **Live DOM:** Always use jQuery `$()` for querying nodes, binding events, and setting state.
- **Vanilla DOM:** `document.createElement` is strictly reserved for ephemeral helper nodes that never enter the live DOM (e.g., hidden file inputs) and for XSS-safe text escaping via the `textContent`/`innerHTML` idiom.

## Boundaries (CRITICAL)
We use `eslint-plugin-boundaries` to enforce strict one-way imports. Lower layers MUST NOT import from higher layers.
**Dependency flow:** `constants <- context, logger, retry <- state <- core <- feature <- entry`

1. `src/foundation/` (Bottom layer)
2. `src/core/`
3. `src/features/`
4. `src/entry/` (Top layer)

*Note: All SillyTavern runtime access MUST go through `src/foundation/context.js`.*
