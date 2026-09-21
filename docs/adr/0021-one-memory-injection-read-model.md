# One Memory Injection read model builds and measures the prompt slot

`src/core/memory-injection.js` owns what ships in the prompt slot behind two calls: `buildInjection(layers, settings)` returns `{ text, parts }` synchronously, and `measureInjection(injection)` returns the token cost of the text it was handed, so the only string that can be counted is one that was built. Two jobs share the module by intent rather than by name: `buildMemoryBody` feeds `buildFullContext` and the pending Layer 0 context with full anchors and no template, while `buildInjection` feeds the slot writer, the macro, the slash-command preview, the settings preview, and the budget bars with compact anchors wrapped in the injection template.

## Considered Options

- **One async read model returning `{ text, usage }`** — every slot write would await a count it does not display, and an unhandled rejection inside a Refresh Port effect would silently skip the injection.
- **A `measureLayers(layers, settings)` compositor** — a second way from layers to a number is a second place for the flags to drift, so the four sites that need a hypothetical layer set write the explicit `await measureInjection(buildInjection(...))`.

## Consequences

The seam stays build-synchronous and measure-asynchronous, because text assembly is pure string work while token counting needs the host tokenizer. `updateUI` builds once and measures once per refresh and hands `{ injection, usage }` to both budget cards and the preview, so `renderPreview` counts nothing and nothing is cached across refreshes — consistency comes from one code path, not from one cached value keyed by Mutation Epoch. Display policy stays in entry: no memories means `text: ''` with the template suppressed entirely, and the placeholders a user reads stay at their call sites. `assembleSummaryBlock` is deleted and `usage` loses the `text` field no caller read.
