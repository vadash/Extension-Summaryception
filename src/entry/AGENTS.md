# Entry Layer (Top Layer)

This directory handles the UI, Event bindings, and settings panels. Workflow mutations do not belong here; import them from `src/features/`.

## UI Guidelines
- Keep HTML control IDs stable.
- Root `settings.html` and `style.css` are the SillyTavern-rendered UI assets; `src/entry/` modules should annotate or bind that DOM only after the template is appended.
- Settings tabs are intentionally scoped: Status for overview/actions, Memory for layer stats/injection preview/import-export/snippet browsing, Settings for connection/retention/budget/layering controls, Prompts for the injection wrapper plus L0/L1+ system/user/repair prompt presets, and Tools for diagnostics/reset/clear memory.
- Prefer compact, theme-aware panels and Font Awesome icons over emoji headings.
- Settings UI reloads should always land on the Status tab.
- Keep budget/status visuals compact and read-only.
- Keep the top enable toggle outside gated content; when disabled, hide the rest of the UI.
- Display token counts compactly with lowercase `k` in status/budget surfaces.
- Use `ui-bind.js` metadata helpers for simple setting persistence: `data-sc-setting` for plain inputs and `data-sc-slider-setting`/`data-sc-partner-input` for slider-chip pairs; keep handlers with workflow side effects explicit.
- Status payload schematics derive from settings/runtime state; do not add save behavior there.
- Slider value chips may show compact `k` values; always clamp them to the paired range min/max/step before saving the setting.
- Range sliders save live on `input`; paired numeric chips save on `change`/blur, accept compact values such as `12k`, and must enforce min/max summary-turn constraints in the UI.
- `settings-help.js` owns metadata-driven help and the shared hover/focus tooltip; it may annotate controls after render, but must not rename HTML IDs or saved setting keys.
- The shared help tooltip is appended to `<body>` and positioned from viewport rectangles so SillyTavern sidebar scrolling cannot clip or offset it.
- The snippet browser uses a keyed jQuery renderer to preserve scroll/focus/edit state during background refreshes; skip rows with a focused `.sc-snippet-edit`.
- Manual Force Summarize and Slop Breaker flows show persistent cancelable progress toasts. Successful manual commits and UI Clear Memory force a browser reload to rebuild SillyTavern prompt state cleanly.
