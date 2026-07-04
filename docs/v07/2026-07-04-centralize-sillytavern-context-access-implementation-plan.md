## Centralize SillyTavern Context Access — Implementation Plan

### New module: `src/foundation/context.js`

A thin facade over `SillyTavern.getContext()` that exposes named getters and passthrough service calls. Every other module imports from here instead of touching the `SillyTavern` global directly.

**Exports:**

```js
// Low-level escape hatch (indexed.js, summarizer-snapshot consumers, etc.)
export function getContext() { ... }   // returns the raw ST context object

// Data getters (return references; callers mutate at their own risk as before)
export function getChat() { ... }              // ctx.chat
export function getChatMetadata() { ... }      // ctx.chatMetadata
export function getExtensionSettings() { ... }  // ctx.extensionSettings
export function getName1() { ... }             // ctx.name1 || 'User'

// Service passthroughs (delegate to ctx, preserving call semantics)
export async function saveMetadata() { ... }
export function saveSettingsDebounced() { ... }
export async function saveChat() { ... }       // no-op if ctx.saveChat is absent
export async function executeSlashCommandsWithOptions(cmd, opts) { ... }
export function setExtensionPrompt(name, text, a, b, c, d) { ... }
export function getGenerateRaw() { ... }       // returns the function ref or null
export function getTokenCountAsync() { ... }   // returns the function ref or null
export function getRequestHeaders() { ... }   // returns headers or { 'Content-Type': 'application/json' }

// Subsystem accessors
export function getPromptManager() { ... }              // ctx.promptManager or null
export function getConnectionManagerRequestService() { ... }  // ctx.ConnectionManagerRequestService or null
export function getSlashCommandParser() { ... }        // ctx.SlashCommandParser or null
export function getSlashCommand() { ... }               // ctx.SlashCommand or null
export function getEventSource() { ... }               // ctx.eventSource or null
export function getEventTypes() { ... }                // ctx.event_types or null
export function getStreamingProcessor() { ... }        // ctx.streamingProcessor or null
```

Each accessor wraps the raw lookup in defensive checks and returns `null`/fallback where the field is absent, so callers can drop their own ad-hoc try/catch guards. `getContext()` is the only escape hatch for genuinely one-off fields.

### Layer boundary

`context.js` sits at the **foundation** level alongside `constants`, `logger`, `retry`, `state`. It imports nothing from other project modules (only reads the `SillyTavern` global). The eslint boundary config gets one new element-type:

```js
{ type: 'context', pattern: 'src/foundation/context.js' }
```

Updated boundary rules:
```text
constants <- context, logger, retry <- state <- core <- feature <- entry
```
- `context` may only import `constants` (for `MODULE_NAME` if needed, though likely not required).
- `logger`, `retry` may import `context` + `constants`.
- `state` may import `context`, `constants`, `logger`.
- `core` onward may import `context` freely.

### Migration plan (file-by-file)

The migration is mechanical and independent per file - each file stops touching `SillyTavern.getContext()` and instead imports the relevant accessor from `foundation/context.js`. Call sites map directly:

| File (layer) | Current call | New import + call |
|---|---|---|
| `foundation/state.js` | `SillyTavern.getContext()` x5 | `getChatMetadata()`, `getExtensionSettings()`, `saveSettingsDebounced()`, `saveMetadata()`, `getName1()` |
| `foundation/logger.js` | destructures `extensionSettings` | `getExtensionSettings()` |
| `core/connection-default.js` | `generateRaw` | `getGenerateRaw()`; null-check replaces arity inspection |
| `core/connection-profile.js` | `ctx.ConnectionManagerRequestService` | `getConnectionManagerRequestService()` |
| `core/connection-transport.js` | `ctx` for service + `getRequestHeaders` | `getConnectionManagerRequestService()` + `getRequestHeaders()` |
| `core/connectionutil.js` | `ctx` for service + `getRequestHeaders` | same as above |
| `core/ghosting.js` | `chat` x3, `executeSlashCommandsWithOptions` x2 | `getChat()`, `executeSlashCommandsWithOptions()` |
| `core/ghosting-reconcile.js` | `chat` x2 | `getChat()` |
| `core/summarizer-batch.js` | `chat` + `ctx` (for `getChatIdentity`) | `getChat()`, `getContext()` (passthrough to snapshot helpers) |
| `core/summarizer-promotion.js` | `ctx` x2 | `getContext()` (snapshot helpers need the raw ctx) |
| `core/summarizer.js` | `chat` x2, `ctx.streamingProcessor` | `getChat()`, `getStreamingProcessor()` |
| `core/persist-state.js` | `ctx.saveChat` | `saveChat()` (no-op fallback built in) |
| `core/prompts.js` | `ctx.promptManager` x3 | `getPromptManager()` |
| `core/token-count.js` | `ctx.getTokenCountAsync` | `getTokenCountAsync()` |
| `features/injection.js` | `setExtensionPrompt` x2 | `setExtensionPrompt()` |
| `features/memory.js` | `chatMetadata` | `getChatMetadata()` |
| `entry/ui.js` | `chat` x3 | `getChat()` |
| `entry/ui-events.js` | `chat`, `executeSlashCommandsWithOptions`, `ctx.saveChat` | `getChat()`, `executeSlashCommandsWithOptions()`, `saveChat()` |
| `entry/ui-connection.js` | `getRequestHeaders` | `getRequestHeaders()` |
| `entry/events.js` | `chat` x2 | `getChat()` |
| `entry/commands.js` | `ctx` for `SlashCommandParser`/`SlashCommand` | `getSlashCommandParser()`, `getSlashCommand()` |
| `index.js` | `eventSource`, `event_types`, `renderExtensionTemplateAsync` | `getEventSource()`, `getEventTypes()`, `getContext().renderExtensionTemplateAsync(...)` (one-off stays on the escape hatch) |

**Note on `summarizer-snapshot.js`:** Functions like `getChatIdentity(ctx)` and `isSameChatSnapshot(snapshot, ctx)` accept a raw `ctx` argument - they do **not** call `getContext()` themselves. Callers in `summarizer-batch.js` and `summarizer-promotion.js` will pass `getContext()` from the new helper. These snapshot helpers stay unchanged.

### Test changes

**`tests/test-helpers.js`:** `installSillyTavernStub()` already mutates `globalThis.SillyTavern` so that `getContext()` returns the stub context. Because the new `context.js` calls `SillyTavern.getContext()` under the hood, this existing stub mechanism works **without changes** for the facade's own tests.

For the **facade unit tests**, add `tests/context.test.js` that exercises each accessor against a stubbed context (e.g., `getChat()` returns the stub chat array, `saveChat()` calls the stub, `getRequestHeaders()` falls back when `ctx.getRequestHeaders` is absent).

Each existing test file's `installSillyTavernStub()` call still works as-is, since the stub shapes the same `ctx` fields the facade now reads. No test-file-level stubbing changes are required; the migration is internally transparent.

### Verification

The project has no build step. Verification per `AGENTS.md`:
- Run `npm test` (Vitest) — all existing tests must pass plus the new `context.test.js`.
- Pre-commit hooks run ESLint (`boundaries` lint must accept the new `context` element type) + Prettier + `tsc --noEmit` via husky/lint-staged. Let auto-fix and re-stage run.
- `knip` (`npm run knip`) — ensure no new unused-export warnings (the facade exports are all consumed).
- `jscpd` (`npm run jscpd`) — ensure no new duplicate-code blocks introduced by the migration.

### Out of scope

- No behavioral changes to any consumer logic — purely a refactor moving the `SillyTavern.getContext()` dependency from N call sites behind 1 helper module.
- No changes to public extension behavior, UI, or data shapes.
- `summarizer-snapshot.js` and `summarizer-commit.js` keep their `ctx`-as-argument interfaces (deemed cleaner than threading individual accessors through snapshot captures). Only their callers switch to the facade's `getContext()` escape hatch.