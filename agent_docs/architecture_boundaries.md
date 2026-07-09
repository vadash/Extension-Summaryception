# Architecture & Boundaries

## Strict Dependency Flow

We use `eslint-plugin-boundaries` to enforce strict one-way imports. Lower layers MUST NOT import from higher layers.
**Flow:** `constants <- context, logger, retry <- state <- core <- feature <- entry`

1. `src/foundation/` (Bottom layer)
2. `src/core/`
3. `src/features/`
4. `src/entry/` (Top layer)

## SillyTavern Context Facade (CRITICAL)

- `src/foundation/context.js` is the **only module allowed** to touch the `SillyTavern` global (e.g., `SillyTavern.getContext()`).
- To access SillyTavern's API anywhere else, you MUST export a safe wrapper from `context.js` and import it.
- Facade wrappers should return `null` or safe fallbacks for missing optional SillyTavern fields instead of throwing.

## State Management

- Layer data lives in `chatMetadata[MODULE_NAME]`.
- Settings are cross-chat (`extensionSettings[MODULE_NAME]`).
- Use `getEffectiveSettings()` for runtime behavior that honors Off/Easy/Advanced mode. Use raw `getSettings()` only for persistence/UI forms.
