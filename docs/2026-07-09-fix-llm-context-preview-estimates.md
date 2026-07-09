I’ll update the Advanced UI context preview so its estimates match the real summarizer call shape shown in the log.

Implementation plan:
- In `src/entry/ui.js`, change `syncLLMContextPreview()` so `L0 Call` estimates raw L0 source plus the injected memory/context budget plus base prompt overhead.
  - Use `maxL0SourceTokens` as the source ceiling, not `Math.min(maxL0SourceTokens, minSummaryBudget)`, because the planner can send up to the hard L0 source cap.
  - Keep the fixed base overhead small and explicit.
- In `src/entry/ui.js`, change `L1+ Merge Call` so it estimates promotion source snippets plus deeper memory/context overhead plus base prompt overhead.
  - Source snippets remain `snippetsPerPromotion * layer0SummaryTokenTarget`.
  - Deeper-memory/context overhead will be estimated from `memoryTokenBudget * 0.5`, matching the fix preview’s conservative approximation.
- In `settings.html`, update the helper text under the context preview to explain that:
  - Main chat calls are memory + live chat + ST prompt.
  - L0 calls are raw chat batch + injected memory/context.
  - L1+ merges are stored summaries + deeper memory layers.
- Add or update a focused UI test if an existing suitable test harness is present; otherwise verify via `npm test` after the code change.

No architecture/data-flow changes are planned, only the read-only estimate math and explanatory UI text.