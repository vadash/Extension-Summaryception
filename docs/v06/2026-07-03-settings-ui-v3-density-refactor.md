# Summaryception Settings UI v3 Density Refactor

## Summary

Refine the current tabbed settings console into a denser SillyTavern sidebar UI. Keep the tab navigation from v2, preserve all existing control IDs and handlers, and avoid any settings/schema/summarization behavior changes. This pass is visual density, hierarchy, and scanability only.

## Key Changes

- Replace the four-card status grid with a slim inline status strip:
  - Format as `Enabled · Idle · 34 snippets · 239 ghosted`.
  - Keep the existing `sc_status_enabled`, `sc_status_worker`, `sc_status_snippets`, and `sc_status_ghosted` IDs by moving them into inline text containers.
- Make tabs and section chrome more compact:
  - Reduce tab height, icon/text gap, section padding, section margins, and heading size.
  - Keep the five tabs: `Status`, `Memory`, `Settings`, `Prompts`, `Tools`.
- Convert toggle cards into dense setting rows:
  - Use smaller icons, one-line title where possible, short hint below, right-aligned checkbox.
  - Apply this to Runtime and Diagnostics toggles.
- Compact action toolbars:
  - Rename visible button labels to `Summarize`, `Stop`, `Repair`, `Import`, `Export`, `Reset`, `Clear`.
  - Preserve IDs: `sc_force_summarize`, `sc_stop_summarize`, `sc_repair`, `sc_import`, `sc_export`, `sc_reset_defaults`, `sc_clear_memory`.
- Stack the Memory tab content by default:
  - Layer stats first, injection preview second, compact import/export toolbar below.
  - Keep snippet browser below with a shorter max height and tighter snippet rows.
- Improve Prompts tab hierarchy:
  - Keep all prompt controls visible.
  - Make System Prompt and Injection Template visually secondary through smaller labels/spacing.
  - Keep User Prompt as the dominant editor.

## Implementation Notes

- Primary edits are `settings.html` and `style.css`; only touch JS if markup changes require no-op-safe UI synchronization.
- Do not add dependencies, build tooling, new persisted settings, or new runtime behavior.
- Keep files under repo guidance: `settings.html` and `style.css` should remain under 500 lines.
- Preserve `src/entry/ui-tabs.js` behavior and `sessionStorage` key `summaryception.activeSettingsTab`.

## Test Plan

- Do not run `npm test` unless explicitly requested.
- Static verification:
  - No duplicate IDs in `settings.html`.
  - All existing UI IDs referenced by `ui.js`, `ui-events.js`, and `ui-connection.js` still exist.
  - `settings.html` and `style.css` remain under 500 lines.
- Manual SillyTavern checks:
  - Each tab switches and preserves current values.
  - Runtime toggles, operations buttons, memory import/export, snippets, connection panels, prompt controls, diagnostics toggles, reset, and clear memory still use existing handlers.
  - Sidebar has no horizontal overflow, clipped button text, or excessive card spacing.

## Assumptions

- v3 keeps the tabbed architecture from v2.
- Target viewport is the standard narrow SillyTavern extension settings panel, even on a 2K display.
- This pass prioritizes compact operational usability over a dashboard/card-heavy appearance.
