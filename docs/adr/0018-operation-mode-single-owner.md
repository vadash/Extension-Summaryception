# Operation Mode owns the on/off and complexity axes

One foundation module (`src/foundation/operation-mode.js`) is the single writer and reader of the stored `uiMode`, `configMode`, `enabled` trio: the `uiMode` radio carries the on/off and complexity axes while `configMode` remembers the Complexity Mode across an Off period, so `enabled === uiMode !== OFF` has one owner instead of the five sites that each held a slice of it. Panel visibility is not part of the verdict: entry renders a View Model of the mode and never computes it.

## Considered Options

- **Deriving `enabled` instead of storing it** — consumers read `.enabled` off raw settings, and deriving it needs the stored-value detection the project forbids.

## Consequences

The Easy guard consumes the stored `uiMode` rather than re-deriving it, and `CONTEXT.md` gains the Operation Mode and Complexity Mode terms.
