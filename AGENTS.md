## Summaryception

SillyTavern browser extension for layered recursive summarization. No build step or bundler; ES modules run directly in the browser.

## Code Style

- Vanilla JS (ES2022+ modules), 4-space indent, single quotes.
- Use camelCase / `SCREAMING_SNAKE_CASE` / PascalCase classes.
- Prefer `const fn = () => {}` inline and `function name() {}` for hoisted helpers.
- Prefix console output with `[Summaryception]` via `LOG_PREFIX`.
- Keep functions under 80 lines, files under 1000 lines, complexity under 15.
- Add JSDoc to exports and useful internal transaction/worker types.
- Runtime globals: `SillyTavern.getContext()`, `toastr`, `$`.
- Settings UI: keep control IDs stable; prefer compact theme-aware panels and Font Awesome icons over emoji headings.

## Boundaries

`eslint-plugin-boundaries` enforces one-way imports:

```text
constants <- logger, retry <- state <- core <- feature <- entry
```

- `src/foundation/constants.js`
- `src/foundation/logger.js`, `src/foundation/retry.js`
- `src/foundation/state.js`
- `src/core/*.js`
- `src/features/*.js`
- `src/entry/*.js`

Lower layers must not import from higher layers.

## Architecture

Layer data lives in `chatMetadata[MODULE_NAME]`.

- Layer 0: turn summaries, 3 turns per snippet by default.
- Layers 1+: meta-summaries promoted from lower layers.
- Recent assistant turns stay verbatim according to `verbatimTurns`.
- Ghosted messages are hidden from the LLM with `/hide` but remain visible in UI.
- Injection uses `setExtensionPrompt()` from the last committed summary snapshot.
- `getChatStore()` normalizes saved chat metadata; app/chat load reconciles branch drift and missing ghosting.
- Background summarization is coalesced through one self-draining worker.
- Prompt-affecting commits/effects are queued during foreground generation.
- Summarizer calls use exponential backoff, 5 retries, 2s-60s.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.

## Testing and Commits

- Never run manual verification checks (lint, format, typecheck, build).
- Use `npm test` for behavior changes; tests are Vitest.
- Manual-check SillyTavern integration with `debugMode` or `traceMode`.
- Test each connection source independently when connection code changes.
- Verify backlog detection, foreground-generation freeze, ghosting, and layer promotion with large chats.
- Pre-commit runs ESLint, Prettier, and `tsc --noEmit` through husky/lint-staged; let it auto-fix and re-stage.
