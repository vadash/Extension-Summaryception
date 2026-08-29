# Summaryception

- Browser-only SillyTavern extension for recursive layered summarization.
- Summarized messages stay visible in chat but are hidden from model context.

## Work Rules

- Preserve unrelated changes.
- Do not commit, push, or sync without explicit authorization.
- Do not add migration shims or legacy constants.
- New defaults apply to all users without stored-value detection.

## Global Boundaries

- Reach SillyTavern runtime globals only through the foundation host facade.
- Read runtime behavior from effective settings.
- Use raw settings only for persistence and UI forms.
- Any summary layer or snippet mutation must bump the store mutation epoch.
- Implicit any is allowed. Annotate parameters that hold structured objects so the type gate checks property reads.

## Commands

- `npm test` runs the suite.
- The pre-commit hook formats the whole repo, then stages every change. Keep the tree free of unrelated edits before a commit.

## Documentation Map

- Architecture and state ownership: `agent_docs/architecture/architecture.md`
- Summarizer, memory, prompts, and connections: `agent_docs/engine/engine.md`
- UI and workflows: `agent_docs/ui/ui.md`
- Testing contracts: `agent_docs/testing/testing.md`
- Cost and budget tuning: `agent_docs/tuning/tuning.md`
- Tests share one setup hook for context bootstrap. Do not repeat it per test.
- Conditional source guidance: `src/AGENTS.md`
- Conditional test guidance: `tests/AGENTS.md`
