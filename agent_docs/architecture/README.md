# Architecture

## Runtime composition

`manifest.json` loads `index.js` and `style.css`. `index.js` renders `settings.html`, initializes feature/UI modules, binds SillyTavern events. Runtime stays browser-native: no build, bundler, server, or application database.

## Dependency policy

One-way flow mandatory:

`constants/context/logger/retry/state <- core <- features <- entry`

Directory view:

1. `src/foundation/`: lowest layer.
2. `src/core/`: engine and runtime mechanics.
3. `src/features/`: user workflows over core.
4. `src/entry/`: DOM, events, commands, orchestration.

`eslint.config.js` owns exact element matrix. Boundary rule currently reports `warn`; still treat violations as architecture failures. Point to config instead of copying its allow-list.

## SillyTavern facade

- Runtime code accesses `SillyTavern` only through `src/foundation/context.js`.
- Add a facade wrapper when new runtime API access is needed; update global test mock in `tests/setup.js` in same change.
- Optional APIs return `null`, `false`, or another safe fallback. Required APIs may throw clear errors when runtime contract is absent.
- Tests may install `globalThis.SillyTavern` stubs through shared helpers.

## State ownership

- Per-chat store: `chatMetadata[MODULE_NAME]`, accessed through `getChatStore()`.
- Cross-chat settings: `extensionSettings[MODULE_NAME]`, accessed through `getSettings()`.
- Runtime behavior: `getEffectiveSettings()` so Off/Easy/Advanced semantics apply.
- Raw settings: persistence, migration, and UI form editing only.
- `saveChatStore()` persists normalized metadata. Layer/snippet mutations also require `bumpSummaryStoreMutationEpoch()`.
