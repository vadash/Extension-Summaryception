# One Memory Injection read model builds and measures the prompt slot

`src/core/memory-injection.js` owns the prompt slot behind two calls: `buildInjection` builds it synchronously, and `measureInjection` returns the token cost of the text it was handed, so only a built string is counted. `buildMemoryBody` feeds the Layer 0 context with full anchors and no template; `buildInjection` feeds the slot sites with compact anchors in the injection template.

## Considered Options

- **One async read model returning `{ text, usage }`** — slot writes would await a count they do not display, and a Refresh Port rejection would silently skip the injection.
- **A `measureLayers` compositor** — a second way from layers to a number is a second place for the flags to drift.

## Consequences

The seam stays build-synchronous and measure-asynchronous; token counting needs the host tokenizer. `updateUI` builds and measures once per refresh and nothing is cached, so consistency comes from one code path, not a cached value. Display policy stays in entry: no memories suppresses the template; placeholders stay at call sites. `assembleSummaryBlock` is deleted and `usage` loses the unread `text` field.
