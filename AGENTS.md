# Summaryception

- Browser-only SillyTavern extension for recursive layered summarization.
- Summarized messages stay visible in chat but are hidden from model context.

## Work Rules

- Preserve unrelated changes.
- Do not commit, push, or sync without explicit authorization.
- Do not add migration shims or legacy constants.
- New defaults apply to all users without stored-value detection.

## Global Boundaries

- Reach SillyTavern runtime globals only through the foundation host facade (ADR-0001). Optional host integrations may return a safe fallback.
- Read runtime behavior from effective settings.
- Use raw settings only for persistence and UI forms.
- Any summary layer or snippet mutation must bump the store mutation epoch (ADR-0003).
- Implicit any is allowed. Annotate parameters that hold structured objects so the type gate checks property reads.

## Commands

- `npm test` runs the suite.
- The pre-commit hook formats the whole repo, then stages every change. Keep the tree free of unrelated edits before a commit.

## Documentation

- Domain glossary: `CONTEXT.md`
- Decisions: `docs/adr/`
- Required host APIs target the current stable SillyTavern release.
- Tests share one setup hook for context bootstrap. Do not repeat it per test.
- Conditional source guidance: `src/AGENTS.md`
- Conditional test guidance: `tests/AGENTS.md`

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (vadash/Extension-Summaryception) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
