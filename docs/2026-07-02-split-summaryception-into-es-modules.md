I’ll split the large `index.js` into small ES modules while keeping browser behavior unchanged and preserving `connectionutil.js` as the API backend layer.

Planned module layout (all implementation modules under `src/`, with root `index.js` kept as the extension entry point):
- `src/constants.js`: `MODULE_NAME`, `LOG_PREFIX`, prompt presets, retry config, default settings.
- `src/state.js`: settings/chat metadata accessors, save helpers, player name lookup.
- `src/logger.js`: `log`, `trace`, and debug helpers.
- `src/retry.js`: retry helpers for summarizer errors.
- `src/ghosting.js`: ghost/unghost/repair message hiding logic.
- `src/chatutils.js`: assistant-turn filtering, passage building, context building.
- `src/prompts.js`: prompt toggle snapshot/disable/restore and summarizer output cleanup.
- `src/summarizer.js`: summarizer state, abort handling, `callSummarizer`, batch/catch-up processing, layer promotion.
- `src/injection.js`: summary block assembly and `setExtensionPrompt` updates.
- `src/commands.js`: slash command registration.
- `src/ui.js`: settings UI, snippet browser, prompt manager, connection UI handlers.
- `src/events.js`: SillyTavern event handlers.
- `index.js`: thin bootstrap that imports modules, renders settings, binds UI, registers events/commands.

Implementation approach:
1. Extract constants and pure helpers first to reduce dependency risk.
2. Move stateful modules next, passing callbacks or importing shared functions where needed.
3. Keep public cross-module functions explicit named exports, avoiding globals except SillyTavern/jQuery/toastr.
4. Run syntax checks by importing the module graph with a lightweight Node parse/import check where possible, and inspect for missing exports/import cycles.
5. Since this repo has no automated test suite, final verification will be static checks plus a concise manual SillyTavern smoke-test checklist.