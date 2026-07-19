# UI and workflows

## DOM rules

- Use jQuery `$()` for live settings DOM queries, delegated events, rendering, and control state.
- Native `document.createElement` limited to ephemeral browser helpers such as import inputs and download anchors. Native window/document listeners allowed for browser lifecycle events.
- `index.js` appends `settings.html` before `src/entry/` binds UI. Keep HTML control IDs stable.
- User-facing workflow results and refresh decisions belong in entry modules where practical. Existing core progress/retry/ghosting toasts are intentional exceptions; do not expand or relocate casually.

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
- Feature modules return structured outcomes; entry modules choose ordinary success/warning wording and UI refresh timing.

## Visual implementation

- Current references: `settings.html`, `style.css`, `src/entry/ui-tabs.js`.
- Status opens on every UI initialization; stored tab clicks never override startup default.
- Primary tab ownership: Models contains Layer 0, Layer 1+ merge, and fallback routes; Settings contains input processing, LLM call context, engine tuning, and memory placement.
- Keep primary tabs sticky, opaque enough over scrolling content, keyboard-visible, and semantically marked with tab roles/ARIA state.
- Prefer compact cards, grids, short helper text, value chips, and collapsed expert tuning. Routine tabs should fit near one settings-panel viewport.
- Inherit SillyTavern theme variables. Use restrained accent, shallow surfaces, clear warning/danger states, no hard-coded light/dark page theme.
- Collapse grids/cards near 520 px. Avoid horizontal scrolling; preserve labels, focus states, and touch targets.
- Read [full visual language](../../docs/ui-visual-language.md) for restyling or sibling-plugin design work.

## Settings help copy

- `src/entry/settings-help.js` builds `HELP_ENTRIES`; `src/entry/settings-help-data.js` builds `CONNECTION_HELP_ENTRIES` and exports them spread into `HELP_ENTRIES`. The `basicHelp` factory is duplicated in both files (the data module cannot import the entry helper). Any change to that template — connector shape, sentence flow, field order — must touch BOTH copies or connection entries drift. `CONNECTION_ENTRY_BUILDERS` reuse shared `group.*` strings, so reword a per-group field in one place rather than per builder.
- The `sliderHelp` template renders `${meaning} Higher ${higher} Lower ${lower} Default ${defaultText}`. The `Higher` / `Lower` / `Default` connectors are pinned by `tests/settings-help.test.js` (`\bHigher\b`, `\bLower\b`, `\bDefault\b`). Keep `meaning` / `higher` / `lower` / `defaultText` as grammatical fragments the template follows; do not repeat those connector words inside the fields. De-scaffolding sliders needs test edits first.
- Setting `detail` concatenates `controlsText + when + risk` as consecutive sentences with no connector labels. Each must be a standalone capitalized sentence ending in a period. Lowercase fragments read as broken grammar.
- A pinned set of copy facts is asserted by `tests/settings-help.test.js:77-96,168-180` and must survive any copy edit verbatim in the field the test reads (template interpolation feeds `detail`): `22k`, `32k`, `~70%`, `24k`, `16k`, `4k`, `Default 3`, `2000+ message chats`, `Default 24`, `ceiling`, `Maximum`, `0 uses the selected provider default`, `0 leaves the provider default`. Slider `Default 3` / `Default 24` come from the template prepending `Default ` to `defaultText`, so keep those `defaultText` values starting with the right number.
- Mask User Role modes (`marker_first`, `rewrite_all`, `marker_last`, `keep_last_user`) are authoritative in `src/core/assistant-role-mask.js`; help copy must not contradict them.
