## Overview

SillyTavern browser extension for layered recursive summarization. No build step, no bundler, no test suite. ES modules run directly in the browser.

## Coding Style

- Vanilla JS (ES2022+, ES modules), camelCase / `SCREAMING_SNAKE_CASE` / PascalCase classes
- 4-space indent, single quotes, `const fn = () => {}` inline / `function name() {}` hoisted
- Prefix console output with `[Summaryception]` (`LOG_PREFIX`)
- Max complexity 15, max 80 lines/function, max 500 lines/file, JSDoc on exports
- Globals: `SillyTavern.getContext()`, `toastr`, `$`

## Linting

ESLint + Prettier run **only on pre-commit** via husky/lint-staged. Never invoke manually -- they auto-fix and re-stage on commit.

## Architecture

Layer system stored in `chatMetadata[MODULE_NAME]`:
- **Layer 0**: turn summaries (3 turns per snippet default)
- **Layers 1+**: meta-summaries promoted from below
- **Verbatim turns**: most recent N assistant messages kept word-for-word
- **Ghosted messages**: hidden from LLM via `/hide`, visible in UI
- **Injection**: `setExtensionPrompt()` prepends summary block to LLM context
- **API calls**: exponential backoff (5 retries, 2s-60s), prompt toggles disabled during summarization

## Testing

No test framework. Manual only: enable `debugMode` (logs) or `traceMode` (detailed entry/exit). Test each connection source independently. Verify backlog detection and layer promotion with 50+ message chats.
