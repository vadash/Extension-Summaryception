# UI & UX Guidelines

This document details the layout, DOM interaction, and user experience rules for Summaryception.

## 1. DOM Access Rules (jQuery)
- **Live DOM:** Always use jQuery `$()` for querying nodes, binding events, and setting state.
- **Vanilla DOM:** `document.createElement` is strictly reserved for:
  1. Ephemeral helper nodes that never enter the live DOM (e.g., hidden `<input type="file">` for imports).
  2. XSS-safe text escaping via the `textContent` / `innerHTML` idiom.

## 2. Tabbed Settings Console
The settings panel is optimized for SillyTavern's narrow extension sidebar:
- **Status:** Overview metrics, enable/pause toggles, and manual operations (Force, Stop, Repair, Slop Breaker).
- **Memory:** Layer stats, injection preview, import/export, and the fine-grained snippet browser.
- **Settings:** Connection, retention, budget, and layering controls.
- **Prompts:** Layer 0 and Layer 1+ system/user prompts, preset selector.
- **Tools:** Diagnostics, debug/trace toggles, strip patterns, reset, and clear memory.

## 3. Input & Slider Behavior
- **Range Sliders:** Save live on `input`.
- **Numeric Chips:** Save on `change` or blur. Typed values automatically clamp to the paired range input's min/max and snap to its step before saving.
- **Compact Notation:** 1000-step token sliders display compact values (e.g., `12k`) while accepting full inputs (`12000`) or compact inputs (`12k`).
- **Dependencies:** Minimum and maximum summary turns mutually constrain each other in the UI.

## 4. Settings Help
Settings help is metadata-driven from `src/entry/settings-help.js`.
- Visible `.sc-hint` text stays short and plain; longer ELI5 guidance lives in the shared hover/focus tooltip.
- Help metadata annotates rendered controls after `settings.html` is appended. It must not rename control IDs or change saved settings keys.
- Slider help should explain what the value means, what higher/lower values do, and the default.
- Non-slider help should explain what the control changes, when to change it, and the main risk.

## 5. UI vs. Business Logic Decoupling
Entry modules (`src/entry/ui.js`, `src/entry/ui-events.js`, `src/entry/ui-dialogs.js`) strictly handle DOM state, toasts, and view refreshes.
- Snippet editing, deleting, regenerating, and orphaned message repair live in `src/features/`.
- Entry layers call feature functions, which return compact status objects (`{ status: 'updated' }`). The UI layer then determines the correct `toastr` feedback.

## 6. Fine-Grained Snippet Browser
The snippet browser uses a keyed jQuery renderer to preserve scroll position, focus, and in-progress snippet edits when the UI refreshes in the background.
- It iterates deepest layer first, Layer 0 last.
- If a row contains a focused `.sc-snippet-edit`, that row is skipped during background refreshes to prevent data loss.

## 7. Manual Operations UX
- **Force Summarize:** Summarizes backlog outside the verbatim window.
- **Slop Breaker:** Summarizes the *live context* too, up to the most recent assistant message. Used when the AI is stuck repeating patterns. Requires a confirmation modal.
- Both manual modes show a persistent, cancelable progress toast and will force a browser reload upon successful commit to rebuild ST's prompt state cleanly.
