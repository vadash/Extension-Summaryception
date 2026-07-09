# UI, Events, and Workflows

## DOM & UI Rendering

- **Live DOM:** Always use jQuery `$()` for querying nodes, binding events, and setting state.
- **Vanilla DOM:** `document.createElement` is strictly reserved for ephemeral helper nodes (e.g., hidden file inputs).
- Root `settings.html` and `style.css` are SillyTavern-rendered assets. `src/entry/` modules bind to this DOM _after_ appending.
- Keep HTML control IDs stable.

## Data Binding

- We use `ui-bind.js` metadata helpers for persistence:
    - `data-sc-setting` for plain inputs.
    - `data-sc-slider-setting` and `data-sc-partner-input` for slider-chip pairs.
- Range sliders save live on `input`; paired numeric chips save on `change`/blur.

## Features & Workflows (`src/features/`)

- **Injection:** Direct placements use `setExtensionPrompt()`; Macro Only registers `{{summaryception_memory}}` and clears direct prompt injection.
- **Maintenance:** Orphaned hidden messages (hidden but no longer owned by Summaryception) should be repaired and unhidden.
- Leave toastr wording/UI refresh decisions to `src/entry/`.
