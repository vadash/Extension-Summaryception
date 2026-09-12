# Test Rules

- Assert outputs, state changes, and functional contracts.
- Do not assert private constants or exact prompt prose.
- For prompt and token work, assert structure and dynamic block placement.
- Shared setup owns host context and logging mocks.
- Shared helpers own runtime fixtures.
- Manual run loop tests must advance the summarized boundary on each commit. A fixed boundary never ends the loop.
- Update shared setup when host facade exports change.
- For prompt structure or token budgets, follow the Prompt rules in `src/AGENTS.md`.
