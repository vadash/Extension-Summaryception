# Summaryception

- Browser-only SillyTavern extension for recursive layered summarization.
- Summarized messages stay visible in chat but are hidden from model context.

## Work Rules

- Preserve unrelated changes.
- Do not add migration shims or legacy constants.
- New defaults apply to all users without stored-value detection.

## Commands

- `npm test` runs the suite.
- The pre-commit hook runs the type gate, formats the whole repo, then stages every change. Keep the tree free of unrelated edits before a commit.

## Documentation

- Domain glossary: `CONTEXT.md`
- Decisions: `docs/adr/`
- Conditional source guidance: `src/AGENTS.md`
- Conditional test guidance: `tests/AGENTS.md`
- Writing an ADR: the shape and the criteria for offering one are in `docs/agents/domain.md` (ADR-0025)

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (vadash/Extension-Summaryception) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five-role vocabulary pinned in `docs/agents/triage-labels.md`; use its label strings verbatim.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
