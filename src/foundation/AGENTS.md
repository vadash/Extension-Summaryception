# Foundation Layer (Bottom Layer)

This directory contains globals, constants, state management, and retry utilities. It has no dependencies on higher layers (`core`, `features`, `entry`).

## SillyTavern Context Facade (CRITICAL)
- `src/foundation/context.js` is the **only module allowed** to touch the `SillyTavern` global (e.g., `SillyTavern.getContext()`).
- If you need to access SillyTavern's API (PromptManager, saveChat, executeSlashCommands, etc.) anywhere else in the codebase, you MUST export a safe wrapper from `context.js` and import it where needed.
- Facade wrappers should return `null` or safe fallbacks for missing optional SillyTavern fields instead of throwing; throw only when the caller cannot proceed without the API.

## State Management
- Layer data lives in `chatMetadata[MODULE_NAME]`.
- Settings are cross-chat (`extensionSettings[MODULE_NAME]`).
- `getSettings()` normalizes persisted settings in place; keep these bounds aligned with matching `settings.html` controls. `minSummaryBudget` is dynamically capped at `maxL0SourceTokens` during normalization -- never persist a budget larger than the source ceiling.
- Runtime behavior that must honor Off/Easy/Advanced mode should read `getEffectiveSettings()`; use raw `getSettings()` only for persistence/UI forms that need to preserve hidden Advanced values.
- Prompt defaults live in `prompt-constants.js`; `getSettings()` resets non-custom prompt presets to current defaults. Only `custom` presets preserve edited prompt text.
- `getChatStore()` normalizes saved chat metadata.
