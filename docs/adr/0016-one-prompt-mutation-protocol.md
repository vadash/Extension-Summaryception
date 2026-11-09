# One prompt-mutation protocol at the Foreground Gate

Every prompt slot write and every commit crosses the Foreground Gate, one instance built at the composition root; the gate — not the writer — decides run-now, queue, or re-run. The renderers are plain writers with no freeze self-check, and a regenerate or swipe drops the rerolled reply's Continuity Checkpoint (ADR-0017) inside the gate's pre-freeze window.

## Considered Options

- **Enforcing slot writes in the foundation host facade** — the freeze is core policy; a facade boolean hides the drop reason.
- **Routing each renderer through the gate itself** — the gate becomes re-entrant and the queue-versus-run decision splits across two layers.

## Consequences

Mid-generation refreshes queue into the `endGeneration` flush commits already use. The gate's surface is one instance's operations replacing thirteen exports, and a test builds its own instance instead of resetting a shared one.
