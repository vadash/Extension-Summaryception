# Summaryception

## WHAT: The Project
Summaryception is a non-destructive, context-aware memory system for SillyTavern. It runs directly in the browser as an extension with no build step or bundler.

## WHY: The Purpose
It replaces brute-force context stuffing with layered recursive summarization. It compresses older conversations into ultra-compact summary snippets organized in layers, hiding original messages from the LLM while keeping them visible in the UI.

## HOW: Working on this codebase
- **Testing**: Run `npm test` to verify behavior changes. 
- **Linting & Formatting**: ESLint and Prettier run auto via husky pre-commit hooks. Never run them manually.
- **Shell**: Windows, PowerShell 7+. Syntax: Chain with ; (no &&, ||, bash heredocs, |, tail). Use Get-Content -Tail. Pass multi-line strings via variables or single-line flags (e.g., git commit -m "").

## Progressive Disclosure
We organize specific context into separate files. Read the relevant files in `agent_docs/` before you start working on a specific part of the system:

- `file:agent_docs/architecture_boundaries.md` - Core structural rules, strict import directions, and the SillyTavern API Facade.
- `file:agent_docs/core_engine.md` - Memory layers, background worker, ghosting, and LLM connection adapters.
- `file:agent_docs/ui_and_features.md` - UI rendering, jQuery rules, data bindings, and high-level workflows.
- `file:agent_docs/ui_visual_language.md` - Reusable Summaryception-family look, layout, density, sticky navigation, and UX conventions.
- `file:agent_docs/testing_guidelines.md` - Vitest rules and mocking strategies.
