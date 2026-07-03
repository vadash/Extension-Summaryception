# Summaryception Settings UI Tabbed Console Refactor

## Summary

Refactor the settings panel into a compact tabbed console optimized for SillyTavern's narrow extension sidebar. Keep all existing setting IDs, saved settings, chat metadata, and summarization behavior unchanged.

## Key Changes

- Replace the long single-scroll layout with a top tab bar:
  - `Status`: overview metrics, enable/pause/ghosting toggles, force/stop/repair actions.
  - `Memory`: layer stats, injection preview, import/export, snippet browser.
  - `Settings`: connection, retention, and layering controls.
  - `Prompts`: system/user prompts, preset selector, injection template.
  - `Diagnostics`: strip patterns, debug/trace/regex toggles, reset defaults, clear memory.
- Make the header smaller and status-focused with current mode, worker state, snippet count, and ghosted count.
- Convert large checkbox cards into compact rows with icon, title, short hint, and right-aligned checkbox.
- Reduce repeated bordered card nesting through tighter spacing and clearer group headers.
- Keep Font Awesome icons, theme variables, stable control IDs, and no new dependencies.

## Implementation Changes

- Update `settings.html` to add a tab nav and tab panels while preserving every existing input/button/textarea/select ID.
- Update `style.css` with compact tab styling, smaller controls, reduced vertical padding, responsive one-column behavior, and improved snippet/preview sizing.
- Add `src/entry/ui-tabs.js` with active-tab behavior stored in `sessionStorage` under `summaryception.activeSettingsTab`.
- Leave summarization, memory, ghosting, prompt injection, connection behavior, and snippet edit/regenerate/delete logic unchanged.

## Test Plan

- Do not run `npm test` unless explicitly requested.
- Manual SillyTavern acceptance checks:
  - Tabs switch without losing input values.
  - Enable, pause, disable ghosting, force summarize, stop, and repair buttons still work.
  - Connection source panels still show/hide correctly.
  - Prompt preset/custom prompt manager still works.
  - Snippet edit, regenerate, and delete still work.
  - Import/export, reset defaults, and clear memory still trigger the same handlers.
  - Sidebar-width layout has no horizontal overflow or clipped button text.

## Assumptions

- The target is the standard SillyTavern extension settings sidebar, not a full-width standalone dashboard.
- This is a navigation and density refactor only.
- No settings schema, metadata schema, summarization behavior, or public API changes.
