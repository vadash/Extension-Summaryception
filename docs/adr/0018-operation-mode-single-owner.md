# Operation Mode owns the on/off and complexity axes

One foundation module (`src/foundation/operation-mode.js`) is the single writer of the stored settings trio `uiMode`, `configMode`, `enabled` and the one place the verdict is read: the intents `setComplexity('easy' | 'advanced')`, `setEnabled(true | false)`, and `selectOff()` write it, and `readOperationMode(settings)` returns the two axes plus the derived `enabled` gate. The stored `uiMode` radio (`off | easy | advanced`) carries both axes while `configMode` remembers the Complexity Mode across an Off period, so the invariant `enabled === uiMode !== OFF` has one owner instead of the five sites that each held a slice of it. Panel visibility is not part of the verdict: `entry/ui-view-models.js` gains `buildEnabledContentModel(mode)` and `syncEnabledContent` renders that View Model, so entry keeps rendering and never computing.

## Considered Options

- **One generic `applyMode({ enabled, complexity })`** — every caller would then have to preserve the axis it does not care about, which is exactly how the `uiMode` re-derivation came to exist.
- **Deriving `enabled` instead of storing it** — `getEffectiveSettings` is identity-equal to `getSettings()` outside Off mode (pinned by `tests/state.test.js`), eleven modules read `.enabled` off a settings object, and the checkbox is declaratively synced from raw settings; deriving it would change that contract and need the stored-value detection the project forbids.
- **An entry-only owner** — the load-time repair lives in foundation and the invariant gates core and feature behavior, so an entry-only owner leaves `state.js` re-deriving `enabled` at load with nobody accountable.
- **Putting panel flags in the foundation verdict** — the module answers what mode the extension is in, not which DOM regions are visible.

## Consequences

`syncEnabledContent` becomes a render of `buildEnabledContentModel`, the Easy guard keeps consuming the stored `uiMode` as a consumer of the invariant rather than a re-derivation of it, and `CONTEXT.md` gains the Operation Mode and Complexity Mode terms.
