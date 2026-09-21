# One prompt-mutation protocol at the Foreground Gate

Every prompt slot write and every commit crosses the Foreground Gate (`src/core/foreground-gate.js`, one instance built at the composition root), and the gate — not the writer — decides whether the work runs now, queues until the freeze lifts, or re-runs when it lifts: an effect that reports it could not finish is re-run by the gate, and a commit that reports itself stale makes the gate ask for a fresh pass through its requeue dependency, so re-running is never the caller's job. The two renderers, `updateInjection` and `updateContinuityInjection`, are plain writers with no freeze self-check: the composition root wraps the Refresh Port effects `injection-refresh` and `continuity-refresh` in `runEffect`, and `beginGeneration({ beforeFreeze })` runs its sync hook first, then reasserts the committed injection, then sets the freeze — so a regenerate or swipe drops the rerolled reply's Continuity Checkpoint (ADR-0017) inside the gate's pre-freeze window rather than through entry-event sequencing.

## Considered Options

- **Enforcing slot writes in the foundation host facade** — the freeze is core policy, a facade boolean hides the drop reason, and every call site still needs a wrapper.
- **Routing each renderer through the gate itself** — the gate becomes re-entrant on itself and the queue-versus-run decision splits across two layers.
- **Keeping the old two-protocol split documented** — the renderer self-check is what shipped the stale-heal hole, so documenting it preserves the bug.
- **Letting a deferred effect queue its own replacement** — the gate and the effect would share one queue, the flush's termination rests on a false return meaning the freeze, and the doc comment it replaced already claimed the gate did it.

## Consequences

Refreshes requested mid-generation now queue and land in the one flush at `endGeneration` that commits already use, instead of being skipped; slot content during a generation is unchanged. The renderers hold no import of the gate, so the feature layer no longer depends on core run control, and the `beforeFreeze` hook stays sync-typed, so a heal can never interleave between the pre-freeze refresh and the freeze. The gate's surface is the one instance's operations — `beginGeneration`, `endGeneration`, `commitWhenSafe`, `runEffect`, `promptWorkGate`, `heal`, `isFrozen`, `reset` — replacing thirteen exports that included four internals and a test-only reset, with the committed-injection refresh moved to the Refresh Port: the freeze, the epoch, and both queues have one owner, and a test builds its own instance instead of resetting a shared one.
