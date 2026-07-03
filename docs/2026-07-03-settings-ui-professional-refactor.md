# Summaryception Settings UI Refactor

## Summary

Refactor the extension settings UI into a cleaner SillyTavern-style control panel without changing summarization behavior or saved settings shape. Preserve existing element IDs used by event bindings and focus on layout, hierarchy, readability, and visual polish.

## Key Changes

- Rework `settings.html` into grouped sections for status, primary actions, memory, snippets, and advanced settings.
- Replace emoji section titles with Font Awesome icons and concise labels.
- Add a compact overview strip for enabled/paused state, summarized index, ghosted count, total snippets, and deepest active layer.
- Move `Clear Memory` into a separated maintenance/danger area.
- Keep existing input/button IDs stable so current handlers continue to work.

## Implementation Notes

- Update `style.css` with shared section, grid, action row, danger zone, textarea, and snippet browser styles.
- Continue using SillyTavern theme variables such as `--SmartThemeBodyColor`, `--SmartThemeBorderColor`, and `--SmartThemeBlurTintColor`.
- Update `src/entry/ui.js` only where needed to render the new overview fields.
- Do not add dependencies, build tooling, images, or persistent schema changes.

## Verification

- Run `npm test`.
- Manually verify in SillyTavern that toggles, actions, connection panels, prompt controls, memory tools, and snippet edit/regenerate/delete still work.

## Assumptions

- This pass is visual and structural only; no snippet search, tabs, or filtering behavior.
- Existing settings and chat metadata remain backward compatible.
- Font Awesome is available through SillyTavern.
