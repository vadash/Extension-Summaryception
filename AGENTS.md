# Summaryception

## Project

Browser-only SillyTavern extension. No runtime server, database, build step, or bundler. Recent chat stays verbatim; older chat becomes recursive summary layers. Summarized messages remain visible in UI but are hidden from model context.

## Work

- Shell: Windows PowerShell 7+. Separate commands with `;`; do not use `&&`, `||`, Bash heredocs, pipelines, or `tail`. Use `Get-Content -Tail`. Pass multiline text through variables or single-line flags.
- Run `npm test` after behavior changes.
- Husky owns ESLint and Prettier. Never run lint or formatting manually.
- Keep runtime code browser-native and unbundled.
- Preserve unrelated user changes. Do not commit, push, or sync unless current user explicitly authorizes it.

## Critical boundaries

- Entry may depend on features, core, and foundation; lower layers never depend upward. See [architecture](agent_docs/architecture/README.md).
- Only `src/foundation/context.js` may access runtime `SillyTavern` global. Add facade wrappers for new API access.
- Runtime behavior uses `getEffectiveSettings()`; raw `getSettings()` is for persistence and UI forms.
- Any summary-layer or snippet mutation must call `bumpSummaryStoreMutationEpoch()`.

## Repository map

- `index.js`: extension composition and SillyTavern event registration.
- `src/foundation/`: constants, runtime facade, settings/store, logging, retry primitives.
- `src/core/`: summarization, promotion, connections, token planning, ghosting.
- `src/features/`: injection, maintenance, persistence, memory workflows.
- `src/entry/`: UI binding, events, dialogs, commands.
- `settings.html` and `style.css`: SillyTavern-rendered UI assets. Read [UI rules](agent_docs/ui/README.md) before editing them.
- `tests/`: Vitest suite. Read `tests/AGENTS.md` before test work.
- Source work also follows `src/AGENTS.md`.

## Beads

- Use Beads for durable tasks and shared memory; never create markdown TODO or MEMORY files.
- Run `bd prime` when workflow context is missing. Full guidance lives in `.agents/skills/beads/SKILL.md`.
- Default profile is conservative: no commit, push, or `bd dolt push` without current authorization.
