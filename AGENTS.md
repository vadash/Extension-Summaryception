## Summaryception

SillyTavern browser extension for layered recursive summarization. No build step or bundler; ES modules run directly in the browser.

## Code Style

- Vanilla JS (ES2022+ modules), 4-space indent, single quotes.
- Use camelCase / `SCREAMING_SNAKE_CASE` / PascalCase classes.
- Prefer `const fn = () => {}` inline and `function name() {}` for hoisted helpers.
- Prefix console output with `[Summaryception]` via `LOG_PREFIX`.
- Keep functions under 80 lines, files under 1000 lines, complexity under 15.
- Add JSDoc to exports and useful internal transaction/worker types.
- Runtime globals: `SillyTavern` (accessed only via `src/foundation/context.js` facade), `toastr`, `$`.
- Settings UI: keep control IDs stable; prefer compact theme-aware panels and Font Awesome icons over emoji headings.
- DOM access: always use jQuery `$()` for the live DOM (querying nodes, binding events, setting state). Vanilla `document.createElement` is only for ephemeral helper nodes that never enter the live DOM and for XSS-safe text escaping via the `textContent`/`innerHTML` idiom.

## Boundaries

`eslint-plugin-boundaries` enforces one-way imports:

```text
constants <- context, logger, retry <- state <- core <- feature <- entry
```

- `src/foundation/constants.js`
- `src/foundation/context.js` (SillyTavern facade; only module that touches `SillyTavern.getContext()`)
- `src/foundation/logger.js`, `src/foundation/retry.js`
- `src/foundation/state.js`
- `src/core/*.js`
- `src/features/*.js`
- `src/entry/*.js`

Lower layers must not import from higher layers. All SillyTavern runtime access goes through `src/foundation/context.js`.

## Architecture

Layer data lives in `chatMetadata[MODULE_NAME]`.

- Layer 0: turn summaries selected by the dynamic verbatim window; overflow waits for `minSummaryTurns` (default 3) and `minSummaryBudget` (default 6000 tokens), capped by `maxSummaryTurns` (default 5).
- Layers 1+: meta-summaries promoted from lower layers.
- Recent chat stays verbatim according to `verbatimTokenBudget` (default 16000 tokens), counting prompt-visible user and assistant messages after regex when enabled.
- Ghosted messages are hidden from the LLM with `/hide` but remain visible in UI.
- Injection uses `setExtensionPrompt()` from the last committed summary snapshot.
- `getChatStore()` normalizes saved chat metadata; app/chat load reconciles branch drift and missing ghosting.
- Background summarization is coalesced through one self-draining worker.
- `SummarizerQueue` owns background worker state; `summarizer.js` remains the runtime facade.
- Prompt-affecting commits/effects are queued during foreground generation.
- Architecture refactor slices are tracked in `docs/2026-07-04-architecture-code-quality-refactor-plan.md`; keep them separate.
- Summarizer calls use exponential backoff, 5 retries, 2s-60s.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.
- SSE stream readers must flush the residual buffer on `done` (malformed trailing chunks) and classify mid-stream disconnects: abort signals propagate unchanged, short partials (<64 chars) throw retryable, longer partials return with a warning. See `docs/2026-07-04-resilient-sse-stream-parsing-in-connection-openai.md`.

## Testing and Commits

- Never run manual verification checks (lint, format, typecheck, build).
- Use `npm test` for behavior changes; tests are Vitest.
- Manual-check SillyTavern integration with `debugMode` or `traceMode`.
- Test each connection source independently when connection code changes.
- Verify backlog detection, foreground-generation freeze, ghosting, and layer promotion with large chats.
- Pre-commit runs ESLint, Prettier, and `tsc --noEmit` through husky/lint-staged; let it auto-fix and re-stage.
