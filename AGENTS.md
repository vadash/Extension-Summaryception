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
- Settings UI reloads should land on the Status tab; keep budget/status visuals there compact and read-only.
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
- Memory Mode: `standard` and `custom` use continuous summarization; `cache` freezes injected memory, uses a 32k default live window, ignores min/max turn sliders, and commits token-balanced cache chunks all-or-nothing.
- Layers 1+: meta-summaries promoted from lower layers.
- Recent chat stays verbatim according to `verbatimTokenBudget` (default 16000 tokens), counting prompt-visible user and assistant messages after regex when enabled.
- Message token stats may be cached in `extra.sc_token_count`; first valid count wins.
- Ghosted messages are hidden from the LLM with `/hide` but remain visible in UI.
- Legacy disable-hiding saves are ignored; repair should visually hide Summaryception-owned metadata ghosts.
- Injection uses `setExtensionPrompt()` from the last committed summary snapshot.
- `getChatStore()` normalizes saved chat metadata; app/chat load reconciles branch drift and missing ghosting.
- `persistChatState()` saves metadata immediately; deferred chat-file saves must be flushed at worker/manual boundaries, not unload.
- Background summarization is coalesced through one self-draining worker.
- `SummarizerQueue` owns background worker state; `summarizer.js` remains the runtime facade.
- `summarizer-auto.js` and `summarizer-manual.js` own orchestration; entry UI owns manual progress/outcome toasts.
- Prompt-affecting commits/effects are queued during foreground generation.
- Summarizer calls use exponential backoff, 5 retries, 2s-60s.
- Pass summarizer AbortSignals to direct fetch adapters and Connection Manager profiles; default `generateRaw()` still uses the local race fallback unless ST exposes a signal.
- Default `generateRaw()` calls must use isolated raw messages and must not mutate PromptManager toggles.
- Connection backends are provider adapters registered in `src/core/connectionutil.js`.
- SSE stream readers must treat incomplete streams as failed attempts: abort signals propagate unchanged, read failures throw retryable errors, and OpenAI-compatible streams must reach `data: [DONE]` before any generated text is accepted.
- Entry UI modules bind DOM and user feedback; workflow mutations belong in `src/features/*.js`.

## Testing and Commits

- Never run manual verification checks (lint, format, typecheck, build).
- Use `npm test` for behavior changes; tests are Vitest.
- Prefer `tests/test-helpers.js` fixtures over inline SillyTavern/toastr/jQuery stubs.
- Manual-check SillyTavern integration with `debugMode` or `traceMode`.
- Test each connection source independently when connection code changes.
- Verify backlog detection, foreground-generation freeze, ghosting, and layer promotion with large chats.
- Pre-commit runs ESLint, Prettier, and `tsc --noEmit` through husky/lint-staged; let it auto-fix and re-stage.
