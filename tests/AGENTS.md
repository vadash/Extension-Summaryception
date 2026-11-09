# Test Rules

- Assert outputs, state changes, and functional contracts.
- Do not assert private constants, exact prompt prose, or help/tooltip copy.
- Before `vitest run` with named paths, `stat` each path; never run a filter list containing a miss.
- Assert notify events through the shared recorder. Assert status and counts, never notice prose or display durations.
- For prompt and token work, assert structure and dynamic block placement.
- Shared setup owns host context and logging mocks.
- Shared helpers own runtime fixtures.
- Manual run loop tests must advance the summarized boundary on each commit. A fixed boundary never ends the loop.
- Update shared setup when host facade exports change.
- For prompt structure or token budgets, follow the Prompt rules in `src/AGENTS.md`.
