# Entry Layer (Top Layer)

This directory handles the UI, Event bindings, and settings panels. Workflow mutations do not belong here; import them from `src/features/`.

## UI Guidelines
- Keep HTML control IDs stable.
- Prefer compact, theme-aware panels and Font Awesome icons over emoji headings.
- Settings UI reloads should always land on the Status tab.
- Keep budget/status visuals compact and read-only.
- Keep the top enable toggle outside gated content; when disabled, hide the rest of the UI.
- Display token counts compactly with lowercase `k` in status/budget surfaces.
- Status payload schematics derive from settings/runtime state; do not add save behavior there.
- Slider value chips may show compact `k` values; always clamp them to the paired range min/max/step before saving the setting.
