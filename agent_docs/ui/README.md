# UI and workflows

## DOM rules

- Use jQuery `$()` for live settings DOM queries, delegated events, rendering, and control state.
- Native `document.createElement` is limited to ephemeral browser helpers such as import inputs and download anchors. Native window/document listeners are allowed for browser lifecycle events.
- `index.js` appends `settings.html` before `src/entry/` binds UI. Keep HTML control IDs stable.
- User-facing workflow results and refresh decisions belong in entry modules where practical. Existing core progress/retry/ghosting toasts are intentional exceptions; do not expand or relocate them casually.

## Data binding

- `ui-bind.js` owns metadata binding:
  - `data-sc-setting`: ordinary controls.
  - `data-sc-slider-setting`: slider/value setting key.
  - `data-sc-partner-input`: slider-chip partner selector.
- Range sliders persist live on `input`; paired numeric chips persist on `change` or blur.
- Prefer shared binders over one-off persistence handlers.

## Feature boundaries

- Injection workflow uses `setExtensionPrompt()` for direct placement. Macro Only registers `{{summaryception_memory}}` and emits no direct prompt.
- Maintenance repairs hidden messages no longer owned by Summaryception by unhiding them.
- Feature modules should return structured outcomes; entry modules choose ordinary success/warning wording and UI refresh timing.

## Visual implementation

- Current references: `settings.html`, `style.css`, `src/entry/ui-tabs.js`.
- Status opens on every UI initialization; stored tab clicks never override startup default.
- Keep primary tabs sticky, opaque enough over scrolling content, keyboard-visible, and semantically marked with tab roles/ARIA state.
- Prefer compact cards, grids, short helper text, value chips, and collapsed expert tuning. Routine tabs should fit near one settings-panel viewport.
- Inherit SillyTavern theme variables. Use restrained accent, shallow surfaces, clear warning/danger states, and no hard-coded light/dark page theme.
- Collapse grids/cards near 520 px. Avoid horizontal scrolling; preserve labels, focus states, and touch targets.
- Read [full visual language](../../docs/ui-visual-language.md) for restyling or sibling-plugin design work.
