# One prompt-mutation protocol at the Foreground Gate

Every prompt slot write and every commit crosses the Foreground Gate (`src/core/summarizer-commit.js`), and the gate — not the writer — decides whether the work runs now, queues until the freeze lifts, or requeues as stale. The two renderers, `updateInjection` and `updateContinuityInjection`, are plain writers with no freeze self-check: the composition root wraps the Refresh Port effects `injection-refresh` and `continuity-refresh` in `runPromptEffect`, and `beginForegroundGeneration({ beforeFreeze })` runs its sync hook first, then reasserts the committed injection, then sets the freeze — so a regenerate or swipe drops the rerolled reply's Continuity Checkpoint (ADR-0017) inside the gate's pre-freeze window rather than through entry-event sequencing.

## Considered Options

- **Enforcing slot writes in the foundation host facade** — the freeze is core policy, a facade boolean hides the drop reason, and every call site still needs a wrapper.
- **Routing each renderer through the gate itself** — the gate becomes re-entrant on itself and the queue-versus-run decision splits across two layers.
- **Keeping the old two-protocol split documented** — the renderer self-check is what shipped the stale-heal hole, so documenting it preserves the bug.

## Consequences

Refreshes requested mid-generation now queue and land in the one flush at `endForegroundGeneration` that commits already use, instead of being skipped; slot content during a generation is unchanged. The renderers lose their `summarizer-commit` imports, so the feature layer no longer depends on core run control, and the gate keeps its interface: the export list is unchanged and the `beforeFreeze` hook stays sync-typed, so a heal can never interleave between the pre-freeze refresh and the freeze.
