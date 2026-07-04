# Consolidate DOM Mutation to Full jQuery (Inline)

**Date:** 2026-07-04
**Scope:** `src/entry/ui-connection.js`, `src/core/summarizer.js`, `src/entry/ui.js`, `src/entry/ui-events.js`, tests

## Summary

The UI layer is now consistently jQuery-based for all live-DOM access. The only remaining vanilla `document.createElement` calls are intentional: XSS-safe text escaping via `textContent`/`innerHTML`, and ephemeral `<input type="file">` / `<a>` nodes that never enter the live DOM.

## Changes

### `src/entry/ui-connection.js` (rewritten)

Converted every `document.getElementById(id)` + `.addEventListener` pair to `$('#id').on(...)`. Replaced `el.value = X` with `$el.val(X)`, `el.style.display` with `.hide()/.show()/.css()`, `el.className` with `.attr('class', ...)`, `el.textContent = msg` with `.text(msg)`. Replaced `<option>` element creation with `$('<option>').val(...).text(...)`. Type casts (`/** @type {HTML...Element} */`) removed. Variable names now prefixed with `$` for jQuery-wrapped elements.

### `src/core/summarizer.js` (`showCatchupDialog`)

Converted overlay creation from `document.createElement('div')` + `.className` + `.innerHTML` + `document.body.appendChild` to `$('<div class="sc-catchup-overlay">').html(...).appendTo('body')`. Replaced `overlay.querySelector('#id').addEventListener('click', fn)` with `$overlay.find('#id').on('click', fn)`. The pre-existing `$('#mes_stop')` stop-button sniff stayed unchanged.

### `src/entry/ui.js`

No logic change. Added a comment to `escapeHtml` noting the deliberate vanilla-DOM use for XSS safety.

### `src/entry/ui-events.js`

No logic change. Added comments to the two `triggerImport*` ephemeral `<input>` creations noting the deliberate vanilla use for non-DOM file-input triggers.

### Tests (`ghosting.test.js`, `summarizer-worker.test.js`, `events.test.js`)

Defensive hardening: widened the `globalThis.$` stubs from `{ find: () => ({ text: vi.fn() }) }` to include `length: 1`. No current test exercises the new `.length` guard paths, but the widening future-proofs against a later test that might.

## Non-Goals

- No new `foundation/dom.js` helper (inlined per module).
- No port of jQuery modules back to vanilla.
- No changes to `index.js`, `context.js`, `ui-tabs.js`, `ghosting.js`, or `connectionutil.js`.
- UI modules remain excluded from vitest coverage (cannot run in headless jsdom).

## Verification

- `npm run lint` passes (0 errors; 1 unrelated pre-existing `complexity` warning in `summarizer-snapshot.js`).
- `npm test` passes (121/121).
- Manual checklist: SillyTavern settings tab - switch connection source (default/profile/ollama/openai), refresh Ollama models, test OpenAI connection, observe status indicator show/hide; trigger catchup dialog by opening a chat with > verbatim turns.

## Convention (recorded in AGENTS.md)

> DOM access: always use jQuery `$()` for the live DOM (querying nodes, binding events, setting state). Vanilla `document.createElement` is only for ephemeral helper nodes that never enter the live DOM and for XSS-safe text escaping via the `textContent`/`innerHTML` idiom.
