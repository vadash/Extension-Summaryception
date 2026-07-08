# Summaryception

## WHAT: The Project
Summaryception is a non-destructive, context-aware memory system for SillyTavern. It runs directly in the browser as an extension with no build step or bundler.

## WHY: The Purpose
It replaces brute-force context stuffing with layered recursive summarization. It compresses older conversations into ultra-compact summary snippets organized in layers, hiding original messages from the LLM while keeping them visible in the UI (Ghosting).

## HOW: Working on this codebase
- **Architecture Navigation:** We use Progressive Disclosure. Do not guess how the app is structured. Read the `AGENTS.md` files in the subdirectories for specific context:
  - `src/AGENTS.md` - Core code style, DOM rules, and strict dependency boundaries.
  - `src/foundation/AGENTS.md` - Globals, Constants, and the SillyTavern API Facade.
  - `src/core/AGENTS.md` - Engine, memory layers, ghosting, and LLM connection adapters.
  - `src/features/AGENTS.md` - High-level workflows and persistence.
  - `src/entry/AGENTS.md` - UI rendering, event binding, and settings panels.
  - `tests/AGENTS.md` - Vitest testing guidelines.

## Scripts & Linting
- **Do not act as a linter.** We use ESLint and Prettier.
- Never run manual verification checks for linting/formatting unless explicitly asked. Rely on `npm run lint`, `npm run format`, and the husky pre-commit hooks (which automatically fix and re-stage).
- Run `npm test` to verify behavior changes.
- **Shell:** This repo runs on Windows. The shell is PowerShell 7+ (modern — `&&` and `||` work, but not bash heredocs, `tail`, `|`, or `;`). Use `;` to chain commands, `Get-Content -Tail` for tail, and pass multi-line strings via variables or single-line flags (e.g. `git commit -m "single line"`).