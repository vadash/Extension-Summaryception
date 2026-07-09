# Memory Mode and Placement Cleanup Plan

## Summary

- Split summarization strategy from memory placement.
- Advanced mode shows only `Standard` and `Cache Friendly` as Memory Mode choices.
- Memory placement becomes an independent Advanced setting for both Advanced Standard and Advanced Cache Friendly.
- Add a `Macro Only` placement that exposes `{{summaryception_memory}}` and performs no direct extension-prompt injection.

## Key Changes

- Remove `Custom` from the Advanced Memory Mode card group; treat persisted `memoryMode: "custom"` as legacy Standard cadence while preserving existing position/role/depth settings.
- Add a `Memory Position` section below expert tuning with `Before Prompt`, `In Prompt`, `In Chat`, and `Macro Only`.
- Hide `Memory Role` for `Macro Only`; show `Chat Depth` only for `In Chat`.
- Register `{{summaryception_memory}}` through the SillyTavern facade:
  - Prefer ST's current macro registry when available.
  - Fall back to the legacy context macro API if needed.
  - Return the same wrapped memory block Summaryception would otherwise inject.
- For `Macro Only`, clear direct extension-prompt injection so memory appears only where the user places the macro.

## UI Cleanup

- Remove the dedicated `Cache Mode` metric panel.
- Make the `Verbatim Window` over-budget state visually explicit in Context Payload, especially in Cache Friendly mode.
- Keep Cache Friendly explanation focused on the mental model: live chat grows to the cache window, then older chat flushes while a protected tail remains live.
- Rename injected-memory wording where needed to avoid implying memory is injected when `Macro Only` is selected.

## Test Plan

- Update injection option tests for independent placement and legacy `custom` migration.
- Add macro registration tests for `{{summaryception_memory}}`, including disabled/no-memory behavior.
- Add UI/state tests for hiding role/depth controls by placement.
- Update cache UI tests after removing `sc_cache_*` fields.
- Run `npm test`.

## Assumptions

- Placement is Advanced-only; Easy mode keeps its preset/default injection behavior.
- Macro name is `summaryception_memory`.
- Cache diagnostics are removed from the main UI rather than moved to another visible panel.
